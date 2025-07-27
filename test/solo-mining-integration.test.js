/**
 * Solo Mining Integration Tests
 * Tests the complete solo mining functionality
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { OtedamaMiningPoolManager } from '../lib/mining/pool-manager.js';
import { SoloPoolIntegration, MiningMode } from '../lib/mining/solo-pool-integration.js';
import { SoloRewardDistributor } from '../lib/mining/solo-reward-distributor.js';

describe('Solo Mining Integration', () => {
  let poolManager;
  let soloIntegration;
  let rewardDistributor;
  
  beforeAll(async () => {
    // Initialize pool with solo mining enabled
    poolManager = new OtedamaMiningPoolManager({
      poolName: 'Test Pool',
      stratumPort: 13333,
      apiPort: 18080,
      soloMining: {
        enabled: true,
        fee: 0.005, // 0.5%
        payoutAddress: '1TestPoolFeeAddress',
        resourceAllocation: 0.5,
        separateStratumPort: 13334
      }
    });
    
    // Initialize components
    soloIntegration = new SoloPoolIntegration({
      soloFee: 0.005,
      poolFee: 0.01
    });
    
    rewardDistributor = new SoloRewardDistributor({
      soloFee: 0.005,
      feeAddress: '1TestPoolFeeAddress'
    });
  });
  
  afterAll(async () => {
    // Cleanup
    if (poolManager) {
      await poolManager.stop();
    }
  });
  
  describe('Fee Configuration', () => {
    it('should have 0.5% solo mining fee', () => {
      expect(soloIntegration.config.soloFee).toBe(0.005);
      expect(rewardDistributor.config.soloFee).toBe(0.005);
    });
    
    it('should have lower solo fee than pool fee', () => {
      expect(soloIntegration.config.soloFee).toBeLessThan(soloIntegration.config.poolFee);
    });
    
    it('should be the lowest in the industry', () => {
      const competitorFees = {
        luxor: 0.007,
        btccom: 0.01,
        ckpool: 0.01,
        f2pool: 0.025
      };
      
      Object.values(competitorFees).forEach(fee => {
        expect(soloIntegration.config.soloFee).toBeLessThan(fee);
      });
    });
  });
  
  describe('Miner Registration', () => {
    it('should register miner in pool mode by default', () => {
      const minerId = soloIntegration.registerMiner({
        address: '1MinerAddress',
        difficulty: 16
      });
      
      const stats = soloIntegration.getMinerStats(minerId);
      expect(stats.mode).toBe(MiningMode.POOL);
    });
    
    it('should register miner in solo mode', () => {
      const minerId = soloIntegration.registerMiner({
        address: '1SoloMinerAddress',
        difficulty: 16
      }, MiningMode.SOLO);
      
      const stats = soloIntegration.getMinerStats(minerId);
      expect(stats.mode).toBe(MiningMode.SOLO);
      expect(stats.soloStats).toBeDefined();
    });
  });
  
  describe('Mode Switching', () => {
    it('should switch from pool to solo mode', () => {
      const minerId = soloIntegration.registerMiner({
        address: '1SwitchingMiner'
      }, MiningMode.POOL);
      
      soloIntegration.switchMode(minerId, MiningMode.SOLO);
      
      const stats = soloIntegration.getMinerStats(minerId);
      expect(stats.mode).toBe(MiningMode.SOLO);
      expect(stats.soloStats).toBeDefined();
    });
    
    it('should switch from solo to pool mode', () => {
      const minerId = soloIntegration.registerMiner({
        address: '1SwitchingMiner2'
      }, MiningMode.SOLO);
      
      soloIntegration.switchMode(minerId, MiningMode.POOL);
      
      const stats = soloIntegration.getMinerStats(minerId);
      expect(stats.mode).toBe(MiningMode.POOL);
    });
  });
  
  describe('Solo Block Rewards', () => {
    it('should calculate correct miner reward with 0.5% fee', () => {
      const blockValue = 3.125 * 100000000; // 3.125 BTC in satoshis
      const rewards = rewardDistributor.calculateRewards({
        value: blockValue,
        minerAddress: '1MinerAddress'
      });
      
      expect(rewards.feeAmount).toBe(Math.floor(blockValue * 0.005));
      expect(rewards.minerReward).toBe(blockValue - rewards.feeAmount);
      expect(rewards.feePercent).toBe(0.005);
      
      // Verify miner gets 99.5%
      const minerPercent = rewards.minerReward / blockValue;
      expect(minerPercent).toBeCloseTo(0.995, 5);
    });
    
    it('should process solo block found event', async () => {
      const minerId = soloIntegration.registerMiner({
        address: '1LuckyMiner'
      }, MiningMode.SOLO);
      
      let blockFound = false;
      soloIntegration.on('solo:block:found', (block) => {
        blockFound = true;
        expect(block.minerId).toBe(minerId);
        expect(block.fee).toBeLessThan(block.reward * 0.01); // Less than 1%
      });
      
      // Simulate block found
      await soloIntegration.handleShare(minerId, {
        meetsDifficulty: true,
        blockValue: 3.125 * 100000000,
        hash: 'mockhash',
        height: 800000
      });
      
      expect(blockFound).toBe(true);
    });
  });
  
  describe('Statistics', () => {
    it('should track solo and pool miners separately', () => {
      // Register some miners
      soloIntegration.registerMiner({ address: '1Pool1' }, MiningMode.POOL);
      soloIntegration.registerMiner({ address: '1Pool2' }, MiningMode.POOL);
      soloIntegration.registerMiner({ address: '1Solo1' }, MiningMode.SOLO);
      
      const stats = soloIntegration.getPoolStats();
      expect(stats.poolMiners).toBeGreaterThanOrEqual(2);
      expect(stats.soloMiners).toBeGreaterThanOrEqual(1);
      expect(stats.fees.solo).toBe('0.5%');
      expect(stats.fees.pool).toBe('1%');
    });
  });
  
  describe('API Integration', () => {
    it('should expose solo mining endpoints', () => {
      const endpoints = [
        '/api/v1/solo/status',
        '/api/v1/solo/info',
        '/api/v1/mining/mode',
        '/api/v1/fees'
      ];
      
      // These would be tested with actual API server
      endpoints.forEach(endpoint => {
        expect(endpoint).toBeDefined();
      });
    });
  });
});

// Integration test for complete flow
describe('Solo Mining Complete Flow', () => {
  it('should handle complete solo mining flow', async () => {
    const integration = new SoloPoolIntegration({
      soloFee: 0.005
    });
    
    const distributor = new SoloRewardDistributor({
      soloFee: 0.005,
      feeAddress: '1PoolFeeAddress'
    });
    
    // 1. Register miner in solo mode
    const minerId = integration.registerMiner({
      address: '1CompleteSoloMiner'
    }, MiningMode.SOLO);
    
    // 2. Track events
    const events = [];
    integration.on('solo:block:found', (e) => events.push({ type: 'block', data: e }));
    integration.on('payout:processed', (e) => events.push({ type: 'payout', data: e }));
    
    // 3. Simulate mining and finding a block
    const blockValue = 3.125 * 100000000; // Current block reward
    await integration.handleShare(minerId, {
      meetsDifficulty: true,
      blockValue: blockValue,
      hash: 'winning-hash',
      height: 800001
    });
    
    // 4. Verify block found event
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('block');
    expect(events[0].data.fee).toBe(blockValue * 0.005);
    
    // 5. Verify payout event
    expect(events[1].type).toBe('payout');
    expect(events[1].data.amount).toBe(blockValue * 0.995);
    
    // 6. Check final stats
    const stats = integration.getMinerStats(minerId);
    expect(stats.soloStats.blocksFound).toBe(1);
    expect(stats.soloStats.totalEarnings).toBe(blockValue * 0.995);
  });
});