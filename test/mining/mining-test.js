/**
 * Mining System Tests
 * Tests all mining-related components and their integration
 */

import { createLogger } from '../../lib/core/logger.js';
import BTCConversionService from '../../services/btc-conversion.js';
import SmartProfitSwitching from '../../lib/mining/smart-profit-switching.js';
import GPUMemoryOptimizer from '../../lib/performance/gpu-memory-optimizer.js';
import HardwareWalletIntegration from '../../lib/wallet/hardware-wallet-integration.js';
import AutoUpdateSystem from '../../lib/core/auto-update-system.js';
import MinerManager from '../../lib/mining/miner-manager.js';
import MinerClient from '../../lib/mining/miner-client.js';
import { OptimizedMiningEngine } from '../../lib/mining/optimized-mining-engine.js';

const logger = createLogger('mining-test');

async function testBTCConversion() {
  logger.info('Testing BTC Conversion Service...');
  
  try {
    const btcService = new BTCConversionService({
      enabled: true,
      updateInterval: 60000
    });
    
    await btcService.start();
    
    // Test exchange rate updates
    await btcService.updateExchangeRates();
    
    // Test conversion calculation
    const ethRate = btcService.getBTCRate('ETH');
    logger.info(`ETH to BTC rate: ${ethRate}`);
    
    const conversion = btcService.calculateConversion(1, 'ETH');
    logger.info('Conversion result:', conversion);
    
    btcService.stop();
    logger.info('✓ BTC Conversion Service test passed');
    return true;
  } catch (error) {
    logger.error('✗ BTC Conversion Service test failed:', error);
    return false;
  }
}

async function testSmartProfitSwitching() {
  logger.info('Testing Smart Profit Switching...');
  
  try {
    const profitSwitcher = new SmartProfitSwitching({
      updateInterval: 300000,
      supportedAlgorithms: ['SHA256', 'Scrypt', 'Ethash'],
      hardware: {
        SHA256: { hashrate: 100000000, power: 100 },
        Scrypt: { hashrate: 1000000, power: 150 },
        Ethash: { hashrate: 50000000, power: 200 }
      }
    });
    
    await profitSwitcher.initialize();
    
    // Test profitability calculation
    const profitability = await profitSwitcher.calculateProfitability();
    logger.info('Profitability data:', Array.from(profitability.entries()));
    
    // Test algorithm switching
    const mostProfitable = await profitSwitcher.getMostProfitableAlgorithm();
    logger.info(`Most profitable algorithm: ${mostProfitable}`);
    
    profitSwitcher.stopMonitoring();
    logger.info('✓ Smart Profit Switching test passed');
    return true;
  } catch (error) {
    logger.error('✗ Smart Profit Switching test failed:', error);
    return false;
  }
}

async function testGPUMemoryOptimizer() {
  logger.info('Testing GPU Memory Optimizer...');
  
  try {
    const optimizer = new GPUMemoryOptimizer({
      targetReduction: 0.30,
      optimizationLevel: 'balanced'
    });
    
    await optimizer.initialize();
    
    // Test GPU detection
    const status = optimizer.getStatus();
    logger.info('GPU Optimizer status:', status);
    
    // Test optimization for algorithm
    if (optimizer.gpuDevices.length > 0) {
      const results = await optimizer.optimizeForAlgorithm('Ethash');
      logger.info('Optimization results:', results);
    }
    
    optimizer.stopMonitoring();
    logger.info('✓ GPU Memory Optimizer test passed');
    return true;
  } catch (error) {
    logger.error('✗ GPU Memory Optimizer test failed:', error);
    return false;
  }
}

async function testHardwareWallet() {
  logger.info('Testing Hardware Wallet Integration...');
  
  try {
    const hwWallet = new HardwareWalletIntegration({
      supportedWallets: ['ledger', 'trezor'],
      confirmationRequired: true
    });
    
    await hwWallet.initialize();
    
    // Test device listing
    const devices = await hwWallet.listDevices();
    logger.info(`Found ${devices.length} hardware wallet(s)`);
    
    logger.info('✓ Hardware Wallet Integration test passed');
    return true;
  } catch (error) {
    logger.error('✗ Hardware Wallet Integration test failed:', error);
    return false;
  }
}

async function testAutoUpdate() {
  logger.info('Testing Auto-Update System...');
  
  try {
    const autoUpdate = new AutoUpdateSystem({
      checkInterval: 3600000,
      updateChannel: 'stable',
      autoDownload: false,
      autoInstall: false
    });
    
    await autoUpdate.initialize();
    
    // Test update check
    const status = autoUpdate.getStatus();
    logger.info('Auto-update status:', status);
    
    autoUpdate.stopUpdateChecking();
    logger.info('✓ Auto-Update System test passed');
    return true;
  } catch (error) {
    logger.error('✗ Auto-Update System test failed:', error);
    return false;
  }
}

async function testMinerManager() {
  logger.info('Testing Miner Manager...');
  
  try {
    const minerManager = new MinerManager({
      minersDir: './miners',
      autoDownload: false,
      autoStart: false
    });
    
    const poolConfig = {
      algorithm: 'sha256',
      url: 'stratum+tcp://localhost:3333',
      wallet: 'bc1qtest123456789',
      password: 'x'
    };
    
    const hardwareConfig = {
      cpu: { cores: 4 },
      gpu: { devices: [] }
    };
    
    await minerManager.initialize(poolConfig, hardwareConfig);
    
    // Test hardware detection
    const hardware = await minerManager.detectHardware();
    logger.info('Detected hardware:', hardware);
    
    // Get statistics
    const stats = minerManager.getStatistics();
    logger.info('Miner statistics:', stats);
    
    await minerManager.shutdown();
    logger.info('✓ Miner Manager test passed');
    return true;
  } catch (error) {
    logger.error('✗ Miner Manager test failed:', error);
    return false;
  }
}

async function testMinerClient() {
  logger.info('Testing Miner Client...');
  
  try {
    const minerClient = new MinerClient('./config/test-miner-config.json');
    
    // Create test config
    minerClient.config = {
      miner: {
        btcAddress: 'bc1qtest123456789',
        workerName: 'test-worker',
        hardware: {
          useCPU: true,
          useGPU: false,
          cpuThreads: 2
        },
        startup: {
          minimized: false,
          runInBackground: false
        },
        idleMining: {
          enabled: false
        },
        performance: {
          priority: 'normal',
          cpuIntensity: 50,
          temperatureLimit: 80
        }
      },
      pools: [{
        name: 'Test Pool',
        url: 'stratum+tcp://localhost:3333',
        priority: 1
      }]
    };
    
    // Test Bitcoin address validation
    const isValid = minerClient.isValidBitcoinAddress('bc1qtest123456789');
    logger.info(`BTC address validation: ${isValid}`);
    
    // Test hardware detection
    await minerClient.detectGPUs();
    
    // Get status
    const status = minerClient.getStatus();
    logger.info('Miner client status:', status);
    
    logger.info('✓ Miner Client test passed');
    return true;
  } catch (error) {
    logger.error('✗ Miner Client test failed:', error);
    return false;
  }
}

async function testOptimizedMiningEngine() {
  logger.info('Testing Optimized Mining Engine...');
  
  try {
    const miningEngine = new OptimizedMiningEngine({
      algorithm: 'sha256',
      threads: 2,
      intensity: 'low',
      batchSize: 10000
    });
    
    // Get mining stats
    const stats = miningEngine.getMiningStats();
    logger.info('Mining engine stats:', stats);
    
    // Submit test work
    const testWork = {
      header: '00000000000000000000000000000000',
      target: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      startNonce: 0,
      endNonce: 1000
    };
    
    miningEngine.submitWork(testWork);
    
    // Wait for initialization
    await new Promise(resolve => {
      miningEngine.once('miningEngineInitialized', resolve);
    });
    
    // Shutdown
    await miningEngine.shutdown();
    logger.info('✓ Optimized Mining Engine test passed');
    return true;
  } catch (error) {
    logger.error('✗ Optimized Mining Engine test failed:', error);
    return false;
  }
}

async function runAllTests() {
  logger.info('=== Starting Mining System Tests ===');
  
  const tests = [
    { name: 'BTC Conversion', func: testBTCConversion },
    { name: 'Smart Profit Switching', func: testSmartProfitSwitching },
    { name: 'GPU Memory Optimizer', func: testGPUMemoryOptimizer },
    { name: 'Hardware Wallet', func: testHardwareWallet },
    { name: 'Auto-Update', func: testAutoUpdate },
    { name: 'Miner Manager', func: testMinerManager },
    { name: 'Miner Client', func: testMinerClient },
    { name: 'Optimized Mining Engine', func: testOptimizedMiningEngine }
  ];
  
  const results = [];
  
  for (const test of tests) {
    logger.info(`\n--- Running ${test.name} Test ---`);
    try {
      const passed = await test.func();
      results.push({ name: test.name, passed });
    } catch (error) {
      logger.error(`${test.name} test crashed:`, error);
      results.push({ name: test.name, passed: false, error: error.message });
    }
  }
  
  // Summary
  logger.info('\n=== Test Summary ===');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  results.forEach(result => {
    const status = result.passed ? '✓' : '✗';
    const message = result.passed ? 'PASSED' : `FAILED${result.error ? `: ${result.error}` : ''}`;
    logger.info(`${status} ${result.name}: ${message}`);
  });
  
  logger.info(`\nTotal: ${passed} passed, ${failed} failed`);
  
  return failed === 0;
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      logger.error('Test runner error:', error);
      process.exit(1);
    });
}

export { runAllTests };