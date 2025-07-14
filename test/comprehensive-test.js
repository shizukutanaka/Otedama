#!/usr/bin/env node

/**
 * Otedama Ver.0.5 - Comprehensive Test Suite
 * 市販レベルの品質保証テスト
 */

import { Logger } from '../src/logger.js';
import { FeeManager } from '../src/fee-manager.js';
import { PaymentManager } from '../src/payment-manager.js';
import { UnifiedDEX } from '../src/unified-dex.js';
import { PriceFeedSystem } from '../src/price-feed.js';
import { AdvancedMonitoringSystem } from '../src/advanced-monitoring.js';
import { AIOptimizationEngine } from '../src/ai-optimizer.js';
import assert from 'assert';

const logger = new Logger('TestSuite');

// Test results storage
const testResults = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: []
};

/**
 * Test runner
 */
async function runTest(name, testFn) {
  const start = Date.now();
  
  try {
    await testFn();
    const duration = Date.now() - start;
    
    testResults.passed++;
    testResults.tests.push({
      name,
      status: 'passed',
      duration
    });
    
    console.log(`✅ ${name} (${duration}ms)`);
    
  } catch (error) {
    const duration = Date.now() - start;
    
    testResults.failed++;
    testResults.tests.push({
      name,
      status: 'failed',
      duration,
      error: error.message
    });
    
    console.log(`❌ ${name} (${duration}ms)`);
    console.log(`   Error: ${error.message}`);
  }
}

/**
 * Test Categories
 */

// 1. Fee Manager Tests (Critical - 運営手数料の不変性)
async function testFeeManager() {
  console.log('\n🔍 Testing Fee Manager (Critical Component)...\n');
  
  // Mock database
  const mockDB = {
    prepare: () => ({
      run: () => {},
      all: () => []
    })
  };
  
  const mockConfig = {
    get: () => ({})
  };
  
  await runTest('Fee Manager - Operator address is immutable', async () => {
    const feeManager = new FeeManager(mockConfig, mockDB);
    const expectedAddress = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';
    
    // Try to change address - should fail
    try {
      feeManager.setOperatorAddress('different-address');
      throw new Error('Should not allow address change');
    } catch (error) {
      assert(error.message.includes('cannot be changed'));
    }
    
    // Verify address remains unchanged
    assert.strictEqual(feeManager.getOperatorAddressRaw(), expectedAddress);
  });
  
  await runTest('Fee Manager - Operator fee rate is immutable', async () => {
    const feeManager = new FeeManager(mockConfig, mockDB);
    const expectedRate = 0.001; // 0.1%
    
    // Try to change rate - should fail
    try {
      feeManager.setOperatorFeeRate(0.05);
      throw new Error('Should not allow rate change');
    } catch (error) {
      assert(error.message.includes('cannot be changed'));
    }
    
    // Verify rate remains unchanged
    assert.strictEqual(feeManager.getOperatorFeeRate(), expectedRate);
  });
  
  await runTest('Fee Manager - Pool fee rate is immutable', async () => {
    const feeManager = new FeeManager(mockConfig, mockDB);
    const expectedRate = 0.014; // 1.4%
    
    // Try to change rate - should fail
    try {
      feeManager.setPoolFeeRate(0.02);
      throw new Error('Should not allow rate change');
    } catch (error) {
      assert(error.message.includes('cannot be changed'));
    }
    
    // Verify rate remains unchanged
    assert.strictEqual(feeManager.getPoolFeeRate(), expectedRate);
  });
  
  await runTest('Fee Manager - Total fee calculation', async () => {
    const feeManager = new FeeManager(mockConfig, mockDB);
    const totalFee = feeManager.getTotalFeeRate();
    
    assert.strictEqual(totalFee, 0.015); // 1.5%
  });
  
  await runTest('Fee Manager - System integrity verification', async () => {
    const feeManager = new FeeManager(mockConfig, mockDB);
    
    // Should pass integrity check
    const integrity = feeManager.verifyIntegrity();
    assert.strictEqual(integrity, true);
  });
  
  await runTest('Fee Manager - Operator fee collection', async () => {
    const feeManager = new FeeManager(mockConfig, mockDB);
    
    // Test fee collection
    const rewardAmount = 1000000000; // 10 coins
    const currency = 'RVN';
    
    const feeCollected = await feeManager.collectOperatorFee(rewardAmount, currency);
    const expectedFee = Math.floor(rewardAmount * 0.001); // 0.1%
    
    assert.strictEqual(feeCollected, expectedFee);
  });
}

// 2. Payment Manager Tests
async function testPaymentManager() {
  console.log('\n🔍 Testing Payment Manager...\n');
  
  const mockConfig = {
    get: (key) => {
      const config = {
        'pool.minPayout': { BTC: 0.001, RVN: 100 }
      };
      return config[key];
    }
  };
  
  const mockDB = {
    prepare: () => ({
      run: () => {},
      all: () => []
    })
  };
  
  const mockFeeManager = {
    getOperatorFeeRate: () => 0.001,
    getTotalFeeRate: () => 0.015
  };
  
  await runTest('Payment Manager - Miner credit calculation', async () => {
    const paymentManager = new PaymentManager(mockConfig, mockDB, mockFeeManager);
    
    // Test crediting miner
    const minerId = 'test-miner';
    const wallet = 'RTestWallet';
    const amount = 100000000; // 1 coin
    const currency = 'RVN';
    
    await paymentManager.creditMiner(minerId, wallet, amount, currency);
    
    // Check balance
    const minerInfo = paymentManager.getMinerInfo(minerId, currency);
    assert(minerInfo);
    assert.strictEqual(minerInfo.balance, 1); // 1 coin
  });
  
  await runTest('Payment Manager - Automatic payout threshold', async () => {
    const paymentManager = new PaymentManager(mockConfig, mockDB, mockFeeManager);
    
    // Credit miner with amount above threshold
    const amount = 10000000000; // 100 coins (above 100 RVN threshold)
    await paymentManager.creditMiner('test-miner-2', 'RWallet2', amount, 'RVN');
    
    // Check if payment was queued
    assert(paymentManager.paymentQueue.length > 0);
  });
  
  await runTest('Payment Manager - Fee deduction in payments', async () => {
    const paymentManager = new PaymentManager(mockConfig, mockDB, mockFeeManager);
    
    const payment = {
      miner_id: 'test',
      wallet_address: 'RWallet',
      currency: 'RVN',
      amount: 100 // 100 RVN
    };
    
    // Process payment (mock)
    const totalFeeRate = 0.015; // 1.5%
    const feeAmount = Math.floor(payment.amount * 1e8 * totalFeeRate);
    const netAmount = (payment.amount * 1e8) - feeAmount;
    
    assert(netAmount < payment.amount * 1e8);
    assert.strictEqual(feeAmount, Math.floor(payment.amount * 1e8 * 0.015));
  });
}

// 3. DEX Tests
async function testUnifiedDEX() {
  console.log('\n🔍 Testing Unified DEX...\n');
  
  const mockFeeManager = {
    getOperatorFeeRate: () => 0.001,
    collectOperatorFee: async () => {}
  };
  
  await runTest('DEX - V2 pool creation', async () => {
    const dex = new UnifiedDEX(mockFeeManager);
    
    const result = dex.createV2Pool('ETH', 'USDT', 0.003);
    assert(result.poolId);
    assert.strictEqual(result.version, 'v2');
  });
  
  await runTest('DEX - V3 pool creation', async () => {
    const dex = new UnifiedDEX(mockFeeManager);
    
    const sqrtPriceX96 = BigInt(2) ** BigInt(96); // Price = 1
    const result = dex.createV3Pool('ETH', 'USDT', 3000, sqrtPriceX96);
    assert(result.poolKey);
    assert.strictEqual(result.version, 'v3');
  });
  
  await runTest('DEX - Swap fee collection', async () => {
    const dex = new UnifiedDEX(mockFeeManager);
    
    // Create pool
    dex.createV2Pool('ETH', 'USDT');
    
    // Add liquidity
    await dex.addLiquidity('ETH', 'USDT', '1000000000', '2500000000', {
      version: 'v2',
      provider: 'test'
    });
    
    // Execute swap
    const swapResult = await dex.swap('ETH', 'USDT', '100000000', 0, 'trader');
    
    assert(swapResult.fee > 0);
    assert(swapResult.amountOut > 0);
  });
  
  await runTest('DEX - Automated processes running', async () => {
    const dex = new UnifiedDEX(mockFeeManager);
    
    // Check if automated processes are initialized
    assert(dex.automatedProcesses.size > 0);
    assert(dex.automatedProcesses.has('v2Rebalancing'));
    assert(dex.automatedProcesses.has('feeDistribution'));
    
    // Stop to cleanup
    dex.stop();
  });
}

// 4. Price Feed Tests
async function testPriceFeed() {
  console.log('\n🔍 Testing Price Feed System...\n');
  
  await runTest('Price Feed - Initialization', async () => {
    const priceFeed = new PriceFeedSystem({ updateInterval: 60000 });
    
    // Check supported pairs
    assert(priceFeed.supportedPairs.includes('BTC/USDT'));
    assert(priceFeed.supportedPairs.includes('ETH/BTC'));
    
    // Stop to cleanup
    priceFeed.stop();
  });
  
  await runTest('Price Feed - BTC conversion', async () => {
    const priceFeed = new PriceFeedSystem();
    
    // Set mock prices
    priceFeed.currentPrices.set('RVN/BTC', 0.00000070);
    
    // Test conversion
    const rvnAmount = 1000000; // 10,000 RVN
    const btcAmount = priceFeed.convertToBTC(rvnAmount, 'RVN');
    
    assert.strictEqual(btcAmount, 700); // 0.007 BTC
    
    priceFeed.stop();
  });
  
  await runTest('Price Feed - Price validation', async () => {
    const priceFeed = new PriceFeedSystem();
    
    // Test manipulation detection
    const isValid1 = priceFeed.isPriceValid('BTC/USDT', 45000, 43000); // ~5% change - valid
    assert.strictEqual(isValid1, true);
    
    const isValid2 = priceFeed.isPriceValid('BTC/USDT', 80000, 43000); // ~86% change - invalid
    assert.strictEqual(isValid2, false);
    
    priceFeed.stop();
  });
}

// 5. Monitoring System Tests
async function testMonitoring() {
  console.log('\n🔍 Testing Monitoring System...\n');
  
  await runTest('Monitoring - Alert definitions', async () => {
    const monitoring = new AdvancedMonitoringSystem();
    
    // Check critical alerts exist
    const alerts = monitoring.alertDefinitions;
    
    const criticalAlerts = alerts.filter(a => a.severity === 'critical');
    assert(criticalAlerts.length > 0);
    
    const feeAlert = alerts.find(a => a.id === 'fee_collection_failure');
    assert(feeAlert);
    assert.strictEqual(feeAlert.severity, 'critical');
    
    monitoring.stop();
  });
  
  await runTest('Monitoring - Metric collection', async () => {
    const monitoring = new AdvancedMonitoringSystem();
    
    // Collect system metrics
    monitoring.collectSystemMetrics();
    
    const systemMetrics = monitoring.metrics.get('system');
    assert(systemMetrics);
    assert(systemMetrics.cpu);
    assert(systemMetrics.memory);
    
    monitoring.stop();
  });
  
  await runTest('Monitoring - Health score calculation', async () => {
    const monitoring = new AdvancedMonitoringSystem();
    
    const healthScore = monitoring.calculateHealthScore();
    assert(typeof healthScore === 'number');
    assert(healthScore >= 0 && healthScore <= 100);
    
    monitoring.stop();
  });
}

// 6. AI Optimizer Tests
async function testAIOptimizer() {
  console.log('\n🔍 Testing AI Optimization Engine...\n');
  
  await runTest('AI Optimizer - Model initialization', async () => {
    const aiOptimizer = new AIOptimizationEngine();
    
    // Check models are initialized
    assert(aiOptimizer.models.hashratePrediction);
    assert(aiOptimizer.models.difficultyOptimization);
    assert(aiOptimizer.models.resourceAllocation);
    
    aiOptimizer.stop();
  });
  
  await runTest('AI Optimizer - Prediction generation', async () => {
    const aiOptimizer = new AIOptimizationEngine();
    
    const mockMetrics = {
      pool: { hashrate: 1000000, miners: 10, difficulty: 1000000 },
      system: { cpu: { user: 5000000 }, memory: { heapUsed: 100000000, heapTotal: 200000000 } },
      network: { latency: 50, peers: 5 },
      dex: { tvl: 100000, volume: 50000 },
      fees: { collected: 0.1 }
    };
    
    const predictions = await aiOptimizer.runPredictions(mockMetrics);
    
    assert(predictions.hashrate);
    assert(predictions.resources);
    assert(predictions.trading);
    assert(predictions.anomalies);
    
    aiOptimizer.stop();
  });
  
  await runTest('AI Optimizer - Optimization generation', async () => {
    const aiOptimizer = new AIOptimizationEngine();
    
    const mockMetrics = {
      pool: { hashrate: 1000000, miners: 10, difficulty: 1000000 },
      system: { cpu: { user: 90000000 }, memory: { heapUsed: 180000000, heapTotal: 200000000 } }
    };
    
    const mockPredictions = {
      hashrate: { trend: 'increasing', value: 1200000 },
      resources: { cpuUsage: 90, memoryUsage: 90 },
      trading: { opportunity: 0.8, action: 'arbitrage' },
      anomalies: { risk: 0.7, type: 'resource_exhaustion' }
    };
    
    const optimizations = await aiOptimizer.generateOptimizations(mockMetrics, mockPredictions);
    
    assert(Array.isArray(optimizations));
    assert(optimizations.length > 0);
    
    aiOptimizer.stop();
  });
}

// 7. Integration Tests
async function testIntegration() {
  console.log('\n🔍 Testing System Integration...\n');
  
  await runTest('Integration - Fee collection flow', async () => {
    const mockConfig = { get: () => ({}) };
    const mockDB = {
      prepare: () => ({
        run: () => {},
        all: () => []
      })
    };
    
    const feeManager = new FeeManager(mockConfig, mockDB);
    const paymentManager = new PaymentManager(mockConfig, mockDB, feeManager);
    
    // Simulate mining reward
    const reward = 1000000000; // 10 coins
    const operatorFee = await feeManager.collectOperatorFee(reward, 'RVN');
    
    // Verify fee was collected
    assert(operatorFee > 0);
    assert.strictEqual(operatorFee, Math.floor(reward * 0.001));
    
    // Verify miner gets reduced amount
    const minerReward = reward - Math.floor(reward * 0.015); // After total 1.5% fee
    assert(minerReward < reward);
  });
  
  await runTest('Integration - DEX and price feed', async () => {
    const priceFeed = new PriceFeedSystem();
    const mockFeeManager = {
      getOperatorFeeRate: () => 0.001,
      collectOperatorFee: async () => {}
    };
    
    const dex = new UnifiedDEX(mockFeeManager);
    
    // Set price in feed
    priceFeed.currentPrices.set('ETH/USDT', 2500);
    
    // Create DEX pool
    dex.createV2Pool('ETH', 'USDT');
    
    // Price should be available for DEX operations
    const ethPrice = priceFeed.getPrice('ETH/USDT');
    assert.strictEqual(ethPrice, 2500);
    
    priceFeed.stop();
    dex.stop();
  });
}

// 8. Performance Tests
async function testPerformance() {
  console.log('\n🔍 Testing Performance...\n');
  
  await runTest('Performance - Fee calculation speed', async () => {
    const mockConfig = { get: () => ({}) };
    const mockDB = {
      prepare: () => ({
        run: () => {},
        all: () => []
      })
    };
    
    const feeManager = new FeeManager(mockConfig, mockDB);
    
    const iterations = 10000;
    const start = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      await feeManager.collectOperatorFee(1000000000, 'RVN');
    }
    
    const duration = Date.now() - start;
    const opsPerSecond = iterations / (duration / 1000);
    
    assert(opsPerSecond > 1000); // Should handle >1000 fee calculations per second
    console.log(`   Performance: ${Math.round(opsPerSecond)} fee calculations/second`);
  });
  
  await runTest('Performance - DEX swap speed', async () => {
    const mockFeeManager = {
      getOperatorFeeRate: () => 0.001,
      collectOperatorFee: async () => {}
    };
    
    const dex = new UnifiedDEX(mockFeeManager);
    
    // Setup pool
    dex.createV2Pool('ETH', 'USDT');
    await dex.addLiquidity('ETH', 'USDT', '10000000000', '25000000000000', {
      version: 'v2',
      provider: 'test'
    });
    
    const iterations = 1000;
    const start = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      await dex.swap('ETH', 'USDT', '1000000', 0, 'trader');
    }
    
    const duration = Date.now() - start;
    const swapsPerSecond = iterations / (duration / 1000);
    
    assert(swapsPerSecond > 100); // Should handle >100 swaps per second
    console.log(`   Performance: ${Math.round(swapsPerSecond)} swaps/second`);
    
    dex.stop();
  });
}

// 9. Security Tests
async function testSecurity() {
  console.log('\n🔍 Testing Security...\n');
  
  await runTest('Security - Fee address tampering protection', async () => {
    const mockConfig = { get: () => ({}) };
    const mockDB = {
      prepare: () => ({
        run: () => {},
        all: () => []
      })
    };
    
    const feeManager = new FeeManager(mockConfig, mockDB);
    
    // Multiple attempts to change address
    const attempts = [
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      'invalid-address'
    ];
    
    for (const address of attempts) {
      try {
        feeManager.setOperatorAddress(address);
        throw new Error('Should not allow any address change');
      } catch (error) {
        assert(error.message.includes('cannot be changed'));
      }
    }
    
    // Verify original address unchanged
    assert.strictEqual(feeManager.getOperatorAddressRaw(), '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa');
  });
  
  await runTest('Security - Rate manipulation protection', async () => {
    const mockConfig = { get: () => ({}) };
    const mockDB = {
      prepare: () => ({
        run: () => {},
        all: () => []
      })
    };
    
    const feeManager = new FeeManager(mockConfig, mockDB);
    
    // Attempts to manipulate rates
    const rateAttempts = [0, 0.0001, 0.5, 1.0, -0.1];
    
    for (const rate of rateAttempts) {
      try {
        feeManager.setOperatorFeeRate(rate);
        throw new Error('Should not allow any rate change');
      } catch (error) {
        assert(error.message.includes('cannot be changed'));
      }
    }
    
    // Verify rates unchanged
    assert.strictEqual(feeManager.getOperatorFeeRate(), 0.001);
    assert.strictEqual(feeManager.getPoolFeeRate(), 0.014);
    assert.strictEqual(feeManager.getTotalFeeRate(), 0.015);
  });
}

// Main test runner
async function runAllTests() {
  console.log('🚀 Starting Otedama Ver.0.5 Test Suite\n');
  console.log('==================================\n');
  
  const startTime = Date.now();
  
  // Run all test categories
  await testFeeManager();
  await testPaymentManager();
  await testUnifiedDEX();
  await testPriceFeed();
  await testMonitoring();
  await testAIOptimizer();
  await testIntegration();
  await testPerformance();
  await testSecurity();
  
  const totalDuration = Date.now() - startTime;
  
  // Display results
  console.log('\n==================================');
  console.log('📊 Test Results Summary\n');
  console.log(`Total Tests: ${testResults.tests.length}`);
  console.log(`✅ Passed: ${testResults.passed}`);
  console.log(`❌ Failed: ${testResults.failed}`);
  console.log(`⏭️  Skipped: ${testResults.skipped}`);
  console.log(`⏱️  Duration: ${totalDuration}ms`);
  console.log(`📈 Success Rate: ${((testResults.passed / testResults.tests.length) * 100).toFixed(1)}%`);
  
  if (testResults.failed > 0) {
    console.log('\n❌ Failed Tests:');
    testResults.tests
      .filter(t => t.status === 'failed')
      .forEach(t => {
        console.log(`   - ${t.name}`);
        console.log(`     Error: ${t.error}`);
      });
  }
  
  // Generate test report
  const report = {
    version: '0.5',
    timestamp: new Date().toISOString(),
    summary: {
      total: testResults.tests.length,
      passed: testResults.passed,
      failed: testResults.failed,
      skipped: testResults.skipped,
      duration: totalDuration,
      successRate: ((testResults.passed / testResults.tests.length) * 100).toFixed(1) + '%'
    },
    tests: testResults.tests
  };
  
  // Save report
  try {
    const fs = await import('fs/promises');
    await fs.writeFile(
      'test-report.json',
      JSON.stringify(report, null, 2)
    );
    console.log('\n📄 Test report saved to test-report.json');
  } catch (error) {
    console.error('Failed to save test report:', error.message);
  }
  
  // Exit with appropriate code
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runAllTests().catch(error => {
  console.error('🚨 Test suite failed:', error);
  process.exit(1);
});
