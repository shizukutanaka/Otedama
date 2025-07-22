/**
 * Comprehensive tests for mining improvements
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { GPUMiningOrchestratorV2 } from '../../lib/mining/gpu/gpu-accelerator-v2.js';
import { AdvancedMiningMemoryManager } from '../../lib/mining/memory/advanced-memory-manager.js';
import { MultiAlgorithmMiner } from '../../lib/mining/algorithms/algorithm-manager-v2.js';
import { AIDifficultyPredictor } from '../../lib/mining/difficulty/ai-difficulty-predictor.js';
import { PoolFailoverManager } from '../../lib/mining/failover/pool-failover-manager.js';
import { IntelligentProfitSwitcher } from '../../lib/mining/profit/intelligent-profit-switcher.js';
import { MiningAnalyticsDashboard } from '../../lib/mining/monitoring/mining-analytics-dashboard.js';

describe('GPU Acceleration V2', () => {
  let gpuOrchestrator;

  beforeEach(() => {
    gpuOrchestrator = new GPUMiningOrchestratorV2({
      maxGPUs: 2,
      autoTune: true,
      thermalManagement: true,
      powerLimit: 500
    });
  });

  afterEach(async () => {
    if (gpuOrchestrator) {
      await gpuOrchestrator.shutdown();
    }
  });

  it('should detect and initialize GPU devices', async () => {
    await gpuOrchestrator.initialize();
    
    expect(gpuOrchestrator.devices.size).toBeGreaterThan(0);
    
    const firstDevice = gpuOrchestrator.devices.values().next().value;
    expect(firstDevice).toHaveProperty('name');
    expect(firstDevice).toHaveProperty('platform');
    expect(firstDevice).toHaveProperty('computeUnits');
  });

  it('should auto-tune GPU for optimal performance', async () => {
    await gpuOrchestrator.initialize();
    
    const device = gpuOrchestrator.devices.values().next().value;
    const initialIntensity = device.tuning.intensity;
    
    await device.autoTune('sha256');
    
    expect(device.tuning.intensity).toBeDefined();
    expect(device.tuning.worksize).toBeDefined();
  });

  it('should apply thermal throttling', async () => {
    await gpuOrchestrator.initialize();
    
    const device = gpuOrchestrator.devices.values().next().value;
    device.metrics.temperature = 85; // High temperature
    
    const throttled = device.applyThermalThrottling();
    
    expect(throttled).toBe(true);
    expect(device.tuning.intensity).toBeLessThan(20);
  });

  it('should manage power limits', async () => {
    await gpuOrchestrator.initialize();
    
    // Simulate high power usage
    for (const device of gpuOrchestrator.devices.values()) {
      device.metrics.powerDraw = 300;
    }
    
    gpuOrchestrator.updateTotalMetrics();
    gpuOrchestrator.performPowerManagement();
    
    expect(gpuOrchestrator.metrics.totalPower).toBeLessThanOrEqual(
      gpuOrchestrator.options.powerLimit * 1.1 // Allow 10% tolerance
    );
  });
});

describe('Advanced Memory Manager', () => {
  let memoryManager;

  beforeEach(() => {
    memoryManager = new AdvancedMiningMemoryManager({
      enableZeroCopy: true,
      enableNUMA: true,
      maxMemoryUsage: 0.8
    });
  });

  afterEach(() => {
    if (memoryManager) {
      memoryManager.shutdown();
    }
  });

  it('should allocate memory from pools efficiently', () => {
    const small = memoryManager.allocate(256);
    const medium = memoryManager.allocate(1024);
    const large = memoryManager.allocate(4096);
    
    expect(small).toBeTruthy();
    expect(medium).toBeTruthy();
    expect(large).toBeTruthy();
    
    // Check pool selection
    expect(memoryManager.selectPool(64).blockSize).toBe(64);
    expect(memoryManager.selectPool(512).blockSize).toBe(1024);
  });

  it('should support zero-copy operations', () => {
    const region = memoryManager.allocate(1024, { shared: true });
    
    expect(region).toBeTruthy();
    expect(region.sharedId).toBeDefined();
    
    const shared = memoryManager.getSharedRegion(region.sharedId);
    expect(shared).toBeTruthy();
    expect(shared.buffer).toBeInstanceOf(SharedArrayBuffer);
  });

  it('should handle memory pressure', () => {
    // Simulate memory pressure
    jest.spyOn(memoryManager, 'checkMemoryPressure').mockReturnValue(true);
    
    const gcSpy = jest.spyOn(memoryManager, 'performEmergencyGC');
    
    memoryManager.allocate(1024);
    
    expect(gcSpy).toHaveBeenCalled();
  });

  it('should track memory statistics', () => {
    memoryManager.allocate(1024);
    memoryManager.allocate(2048);
    
    const stats = memoryManager.getStats();
    
    expect(stats.totalAllocated).toBe(3072);
    expect(stats.currentUsage).toBe(3072);
    expect(stats.peakUsage).toBeGreaterThanOrEqual(3072);
  });
});

describe('Multi-Algorithm Mining', () => {
  let multiMiner;

  beforeEach(() => {
    multiMiner = new MultiAlgorithmMiner({
      maxAlgorithms: 3,
      autoSwitch: true,
      benchmarkOnStart: false
    });
  });

  afterEach(async () => {
    if (multiMiner) {
      await multiMiner.stopMining();
    }
  });

  it('should load multiple algorithms', async () => {
    // Mock algorithm loading
    jest.spyOn(multiMiner.loader, 'loadAlgorithm').mockResolvedValue({
      name: 'sha256',
      hash: jest.fn()
    });
    
    await multiMiner.initialize(['sha256', 'scrypt', 'ethash']);
    
    expect(multiMiner.activeAlgorithms.size).toBe(3);
    expect(multiMiner.activeAlgorithms.has('sha256')).toBe(true);
  });

  it('should benchmark algorithms', async () => {
    const mockAlgorithm = {
      name: 'sha256',
      hash: jest.fn().mockResolvedValue('hash')
    };
    
    const result = await multiMiner.benchmark.benchmark(mockAlgorithm, 100);
    
    expect(result).toHaveProperty('hashRate');
    expect(result.hashRate).toBeGreaterThan(0);
    expect(result).toHaveProperty('latency');
  });

  it('should detect hardware capabilities', () => {
    const hardware = multiMiner.detectHardware();
    
    expect(hardware).toHaveProperty('cores');
    expect(hardware).toHaveProperty('memory');
    expect(hardware.cores).toBeGreaterThan(0);
  });

  it('should switch algorithms based on performance', async () => {
    // Setup mock algorithms with different performance
    multiMiner.activeAlgorithms.set('sha256', {
      algorithm: { name: 'sha256' },
      metadata: { category: 'sha' },
      active: false
    });
    
    multiMiner.activeAlgorithms.set('scrypt', {
      algorithm: { name: 'scrypt' },
      metadata: { category: 'scrypt' },
      active: false
    });
    
    multiMiner.performance.set('sha256', { hashRate: 1000, efficiency: 0.9 });
    multiMiner.performance.set('scrypt', { hashRate: 1500, efficiency: 0.95 });
    
    multiMiner.selectBestAlgorithm();
    
    expect(multiMiner.currentAlgorithm).toBe('scrypt');
  });
});

describe('AI Difficulty Predictor', () => {
  let predictor;

  beforeEach(() => {
    predictor = new AIDifficultyPredictor({
      strategy: 'hybrid',
      targetBlockTime: 10,
      enableML: true
    });
  });

  it('should add blocks and update analyzers', () => {
    const block = {
      height: 100,
      timestamp: Date.now(),
      difficulty: 1000,
      blockTime: 12
    };
    
    predictor.addBlock(block);
    
    expect(predictor.blockHistory).toHaveLength(1);
    expect(predictor.blockTimeAnalyzer.data).toHaveLength(1);
  });

  it('should calculate different adjustment strategies', () => {
    // Add sample blocks
    for (let i = 0; i < 20; i++) {
      predictor.addBlock({
        height: i,
        timestamp: Date.now() + i * 10000,
        difficulty: 1000,
        blockTime: 8 + Math.random() * 8 // 8-16 seconds
      });
    }
    
    const reactive = predictor.reactiveAdjustment();
    const predictive = predictor.predictiveAdjustment();
    const hybrid = predictor.hybridAdjustment();
    
    expect(reactive).toBeGreaterThan(0);
    expect(predictive).toBeGreaterThan(0);
    expect(hybrid).toBeGreaterThan(0);
  });

  it('should detect trends in block times', () => {
    // Add trending data
    for (let i = 0; i < 30; i++) {
      predictor.blockTimeAnalyzer.addDataPoint(10 + i * 0.5, Date.now() + i * 10000);
    }
    
    const trend = predictor.blockTimeAnalyzer.detectTrend();
    expect(trend).toBe('uptrend');
  });

  it('should predict next difficulty', () => {
    // Add historical data
    for (let i = 0; i < 50; i++) {
      predictor.difficultyAnalyzer.addDataPoint(1000 + i * 10, Date.now() + i * 10000);
    }
    
    const prediction = predictor.predictNextDifficulty();
    expect(prediction).toBeGreaterThan(1000);
  });
});

describe('Pool Failover Manager', () => {
  let failoverManager;

  beforeEach(() => {
    failoverManager = new PoolFailoverManager({
      strategy: 'performance_based',
      maxPools: 5
    });
  });

  afterEach(() => {
    if (failoverManager) {
      failoverManager.stop();
    }
  });

  it('should add and manage multiple pools', () => {
    failoverManager.addPool({
      id: 'pool1',
      name: 'Primary Pool',
      url: 'stratum+tcp://pool1.example.com',
      port: 3333,
      priority: 10
    });
    
    failoverManager.addPool({
      id: 'pool2',
      name: 'Backup Pool',
      url: 'stratum+tcp://pool2.example.com',
      port: 3333,
      priority: 5
    });
    
    expect(failoverManager.pools.size).toBe(2);
    expect(failoverManager.primaryPool.id).toBe('pool1');
  });

  it('should select pools based on strategy', () => {
    // Add pools with different scores
    const pool1 = {
      id: 'pool1',
      name: 'Pool 1',
      url: 'stratum+tcp://pool1.example.com',
      port: 3333,
      weight: 2
    };
    
    const pool2 = {
      id: 'pool2',
      name: 'Pool 2',
      url: 'stratum+tcp://pool2.example.com',
      port: 3333,
      weight: 1
    };
    
    failoverManager.addPool(pool1);
    failoverManager.addPool(pool2);
    
    // Set health status
    failoverManager.pools.get('pool1').health = 'healthy';
    failoverManager.pools.get('pool2').health = 'healthy';
    
    failoverManager.activePools.add('pool1');
    failoverManager.activePools.add('pool2');
    
    // Test round-robin
    failoverManager.options.strategy = 'round_robin';
    const rr1 = failoverManager.selectRoundRobin();
    const rr2 = failoverManager.selectRoundRobin();
    expect(rr1).not.toBe(rr2);
    
    // Test weighted selection
    failoverManager.options.strategy = 'weighted';
    const weighted = [];
    for (let i = 0; i < 100; i++) {
      const selected = failoverManager.selectWeighted();
      weighted.push(selected.id);
    }
    const pool1Count = weighted.filter(id => id === 'pool1').length;
    expect(pool1Count).toBeGreaterThan(50); // Should favor pool1
  });

  it('should trigger failover on failures', () => {
    failoverManager.addPool({
      id: 'pool1',
      name: 'Primary Pool',
      url: 'stratum+tcp://pool1.example.com',
      port: 3333
    });
    
    failoverManager.addPool({
      id: 'pool2',
      name: 'Backup Pool',
      url: 'stratum+tcp://pool2.example.com',
      port: 3333
    });
    
    failoverManager.currentPool = failoverManager.pools.get('pool1');
    failoverManager.activePools.add('pool2');
    
    const newPool = failoverManager.triggerFailover('connection_failed');
    
    expect(newPool).toBeTruthy();
    expect(failoverManager.stats.failovers).toBe(1);
  });
});

describe('Intelligent Profit Switcher', () => {
  let profitSwitcher;

  beforeEach(() => {
    profitSwitcher = new IntelligentProfitSwitcher({
      model: 'holistic',
      strategy: 'adaptive',
      powerCost: 0.10
    });
  });

  afterEach(() => {
    if (profitSwitcher) {
      profitSwitcher.stop();
    }
  });

  it('should calculate coin profitability', () => {
    profitSwitcher.addCoin({
      coin: 'BTC',
      algorithm: 'SHA256',
      price: 50000,
      difficulty: 1e12,
      blockReward: 6.25,
      blockTime: 600,
      networkHashrate: 1e20,
      poolFee: 0.01
    });
    
    profitSwitcher.tuningParams.hashrate = 100e12; // 100 TH/s
    profitSwitcher.tuningParams.powerConsumption = 3000; // 3000W
    
    const coin = profitSwitcher.coins.get('BTC');
    const profit = coin.calculateProfit(
      profitSwitcher.tuningParams.hashrate,
      profitSwitcher.options.powerCost,
      profitSwitcher.tuningParams.powerConsumption
    );
    
    expect(profit).toHaveProperty('revenue');
    expect(profit).toHaveProperty('powerCost');
    expect(profit).toHaveProperty('profit');
    expect(profit.powerCost).toBe(7.2); // 3kW * 24h * $0.10
  });

  it('should rank coins by profitability', () => {
    profitSwitcher.addCoin({
      coin: 'BTC',
      algorithm: 'SHA256',
      price: 50000,
      difficulty: 1e12,
      blockReward: 6.25,
      blockTime: 600,
      networkHashrate: 1e20
    });
    
    profitSwitcher.addCoin({
      coin: 'LTC',
      algorithm: 'Scrypt',
      price: 200,
      difficulty: 1e8,
      blockReward: 12.5,
      blockTime: 150,
      networkHashrate: 500e12
    });
    
    profitSwitcher.tuningParams.hashrate = 1e12;
    
    const ranking = profitSwitcher.getProfitabilityRanking();
    
    expect(ranking).toHaveLength(2);
    expect(ranking[0]).toHaveProperty('profit');
    expect(ranking[0]).toHaveProperty('score');
  });

  it('should auto-tune hardware for algorithms', () => {
    const coin = {
      coin: 'ETH',
      algorithm: 'Ethash'
    };
    
    profitSwitcher.autoTuneForCoin(coin);
    
    expect(profitSwitcher.tuningParams.overclock.memory).toBeGreaterThan(0);
    expect(profitSwitcher.tuningParams.efficiency).toBeLessThan(1);
  });
});

describe('Mining Analytics Dashboard', () => {
  let dashboard;

  beforeEach(() => {
    dashboard = new MiningAnalyticsDashboard({
      port: 3002,
      enableWebSocket: false,
      enableAPI: false
    });
  });

  afterEach(() => {
    if (dashboard) {
      dashboard.stop();
    }
  });

  it('should store and retrieve time series data', () => {
    dashboard.updateMetrics({
      hashrate: 100e12,
      temperature: { gpu0: 70, gpu1: 72 },
      power: 3000,
      efficiency: 0.95
    });
    
    const latestHashrate = dashboard.timeSeriesStore.getLatest('hashrate');
    expect(latestHashrate.value).toBe(100e12);
    
    const stats = dashboard.timeSeriesStore.getStats('hashrate');
    expect(stats).toHaveProperty('avg');
    expect(stats).toHaveProperty('min');
    expect(stats).toHaveProperty('max');
  });

  it('should trigger alerts based on rules', () => {
    const alertSpy = jest.spyOn(dashboard.alertManager, 'triggerAlert');
    
    dashboard.updateMetrics({
      hashrate: 100e12,
      temperature: { gpu0: 90 }, // High temperature
      shares: { accepted: 95, rejected: 5 }
    });
    
    dashboard.alertManager.checkRules(dashboard.currentMetrics);
    
    expect(alertSpy).toHaveBeenCalled();
    expect(dashboard.alertManager.getActiveAlerts()).toHaveLength(1);
  });

  it('should detect performance anomalies', () => {
    // Add baseline data
    for (let i = 0; i < 100; i++) {
      dashboard.timeSeriesStore.addPoint('hashrate', 100e12 + Math.random() * 5e12);
    }
    
    dashboard.performanceAnalyzer.calculateBaseline('hashrate');
    
    // Add anomalous data
    dashboard.timeSeriesStore.addPoint('hashrate', 50e12); // Low hashrate
    
    const anomalies = dashboard.performanceAnalyzer.detectAnomalies();
    
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe('low');
  });

  it('should calculate statistics correctly', () => {
    dashboard.updateMetrics({
      hashrate: 100e12,
      shares: { accepted: 100, rejected: 5 },
      revenue: { current: 0.001 }
    });
    
    const stats = dashboard.getStatistics();
    
    expect(stats).toHaveProperty('currentHashrate');
    expect(stats).toHaveProperty('totalShares');
    expect(stats.totalShares).toBe(105);
  });
});

describe('Integration Tests', () => {
  it('should integrate GPU mining with memory management', async () => {
    const gpuOrchestrator = new GPUMiningOrchestratorV2();
    const memoryManager = new AdvancedMiningMemoryManager();
    
    await gpuOrchestrator.initialize();
    
    // Allocate memory for GPU mining
    const workData = memoryManager.allocate(4096, { shared: true });
    expect(workData).toBeTruthy();
    
    // Cleanup
    await gpuOrchestrator.shutdown();
    memoryManager.shutdown();
  });

  it('should integrate profit switching with analytics', () => {
    const profitSwitcher = new IntelligentProfitSwitcher();
    const dashboard = new MiningAnalyticsDashboard();
    
    // Add coin and update metrics
    profitSwitcher.addCoin({
      coin: 'BTC',
      algorithm: 'SHA256',
      price: 50000,
      difficulty: 1e12,
      blockReward: 6.25,
      blockTime: 600,
      networkHashrate: 1e20
    });
    
    profitSwitcher.tuningParams.hashrate = 100e12;
    
    const stats = profitSwitcher.getStats();
    
    dashboard.updateMetrics({
      hashrate: profitSwitcher.tuningParams.hashrate,
      revenue: { current: stats.currentProfit }
    });
    
    expect(dashboard.currentMetrics.revenue.current).toBe(stats.currentProfit);
    
    // Cleanup
    profitSwitcher.stop();
    dashboard.stop();
  });
});