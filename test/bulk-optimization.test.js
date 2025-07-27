/**
 * Bulk Conversion Optimization Tests
 * Tests the bulk conversion aggregation system
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BulkConversionOptimizer, ConversionState } from '../lib/optimization/bulk-conversion-optimizer.js';
import { ExternalServiceConverter } from '../lib/integrations/external-service-converter.js';

describe('Bulk Conversion Optimizer', () => {
  let optimizer;
  
  beforeEach(() => {
    optimizer = new BulkConversionOptimizer({
      batchingEnabled: true,
      minBatchSize: {
        BTC: 0.01,
        ETH: 0.1,
        LTC: 1,
        default: 50
      },
      maxWaitTime: 3600000, // 1 hour
      checkInterval: 60000   // 1 minute
    });
  });
  
  afterEach(() => {
    optimizer.stop();
  });
  
  describe('Conversion Batching', () => {
    it('should batch small conversions together', async () => {
      const conversions = [
        { fromCoin: 'ETH', toCoin: 'BTC', amount: 0.05, address: '0xaddr1', userId: 'user1' },
        { fromCoin: 'ETH', toCoin: 'BTC', amount: 0.03, address: '0xaddr2', userId: 'user2' },
        { fromCoin: 'ETH', toCoin: 'BTC', amount: 0.04, address: '0xaddr3', userId: 'user3' }
      ];
      
      // Add conversions
      const results = [];
      for (const conv of conversions) {
        const result = await optimizer.addConversion(conv);
        results.push(result);
      }
      
      // All should be queued
      expect(results.every(r => r.status === 'queued')).toBe(true);
      
      // Check batch queue
      const batchStatus = optimizer.getBatchStatus();
      expect(batchStatus['ETH:BTC']).toBeDefined();
      expect(batchStatus['ETH:BTC'].conversions).toBe(3);
      expect(batchStatus['ETH:BTC'].totalAmount).toBe(0.12);
      expect(parseFloat(batchStatus['ETH:BTC'].progress.replace('%', ''))).toBeGreaterThan(100);
    });
    
    it('should process immediately if amount exceeds batch threshold', async () => {
      const largeConversion = {
        fromCoin: 'ETH',
        toCoin: 'BTC',
        amount: 0.25, // 2.5x minimum
        address: '0xaddr',
        userId: 'whale'
      };
      
      // Mock immediate processing
      optimizer.processImmediate = jest.fn().mockResolvedValue({
        id: 'test',
        status: 'completed',
        result: { success: true }
      });
      
      const result = await optimizer.addConversion(largeConversion);
      
      expect(optimizer.processImmediate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 0.25,
          fromCoin: 'ETH',
          toCoin: 'BTC'
        })
      );
    });
    
    it('should respect max wait time', async () => {
      jest.useFakeTimers();
      
      const conversion = {
        fromCoin: 'LTC',
        toCoin: 'BTC',
        amount: 0.5, // Below minimum of 1 LTC
        address: 'ltcaddr',
        userId: 'user1'
      };
      
      // Mock batch processing
      optimizer.processBatch = jest.fn();
      
      await optimizer.addConversion(conversion);
      
      // Fast forward to max wait time
      jest.advanceTimersByTime(3600000);
      
      expect(optimizer.processBatch).toHaveBeenCalledWith('LTC:BTC', 'timeout');
      
      jest.useRealTimers();
    });
  });
  
  describe('Volume Discounts', () => {
    it('should apply correct volume discounts', () => {
      const testCases = [
        { value: 500, expectedDiscount: 0 },
        { value: 1500, expectedDiscount: 0.0005 },
        { value: 7000, expectedDiscount: 0.001 },
        { value: 25000, expectedDiscount: 0.0015 },
        { value: 100000, expectedDiscount: 0.002 }
      ];
      
      testCases.forEach(({ value, expectedDiscount }) => {
        const discount = optimizer.getVolumeDiscount(value);
        expect(discount).toBe(expectedDiscount);
      });
    });
    
    it('should calculate savings from bulk conversion', async () => {
      const batch = {
        conversions: [
          { amount: 0.1, address: 'addr1', userId: 'user1' },
          { amount: 0.15, address: 'addr2', userId: 'user2' },
          { amount: 0.2, address: 'addr3', userId: 'user3' }
        ],
        totalAmount: 0.45
      };
      
      // Mock service with bulk conversion
      const mockService = {
        name: 'simpleswap',
        executeBulkConversion: jest.fn().mockResolvedValue({
          success: true,
          fee: batch.totalAmount * 0.0015, // 0.15% for bulk
          transactions: batch.conversions.map(c => ({
            address: c.address,
            amount: c.amount,
            txId: 'test_tx'
          }))
        })
      };
      
      optimizer.findBestBulkService = jest.fn().mockResolvedValue(mockService);
      optimizer.estimateValue = jest.fn().mockResolvedValue(1350); // $1350 worth
      
      const result = await optimizer.executeBatchConversion(batch, 'ETH:BTC');
      
      // Check volume discount applied
      expect(result.volumeDiscount).toBe(0.0005); // $1k+ discount
      
      // Calculate savings
      const standardFee = 0.45 * 0.002; // 0.2% standard
      const actualFee = 0.45 * 0.0015; // 0.15% bulk
      const volumeSavings = 0.45 * 0.0005; // Volume discount
      const totalSavings = (standardFee - actualFee) + volumeSavings;
      
      expect(result.savedAmount).toBeCloseTo(totalSavings, 6);
    });
  });
  
  describe('Batch Processing', () => {
    it('should process batch when minimum size is met', async () => {
      optimizer.processBatch = jest.fn();
      
      // Add conversions until batch threshold
      await optimizer.addConversion({
        fromCoin: 'ETH',
        toCoin: 'BTC',
        amount: 0.06,
        address: 'addr1',
        userId: 'user1'
      });
      
      expect(optimizer.processBatch).not.toHaveBeenCalled();
      
      // This should trigger batch processing (total 0.11 > 0.1 minimum)
      await optimizer.addConversion({
        fromCoin: 'ETH',
        toCoin: 'BTC',
        amount: 0.05,
        address: 'addr2',
        userId: 'user2'
      });
      
      expect(optimizer.processBatch).toHaveBeenCalledWith('ETH:BTC', 'size_met');
    });
    
    it('should handle failed batch by retrying individual conversions', async () => {
      const batch = {
        conversions: [
          { id: '1', fromCoin: 'ETH', toCoin: 'BTC', amount: 0.1, state: ConversionState.BATCHED },
          { id: '2', fromCoin: 'ETH', toCoin: 'BTC', amount: 0.2, state: ConversionState.BATCHED }
        ],
        totalAmount: 0.3
      };
      
      optimizer.batchQueue.set('ETH:BTC', batch);
      optimizer.executeBatchConversion = jest.fn().mockRejectedValue(new Error('Service unavailable'));
      optimizer.processImmediate = jest.fn().mockResolvedValue({ success: true });
      
      await optimizer.processBatch('ETH:BTC', 'test');
      
      // Should retry each conversion individually
      expect(optimizer.processImmediate).toHaveBeenCalledTimes(2);
      expect(batch.conversions[0].state).toBe(ConversionState.FAILED);
      expect(batch.conversions[1].state).toBe(ConversionState.FAILED);
    });
  });
  
  describe('Statistics', () => {
    it('should track optimization statistics', async () => {
      // Simulate completed batch
      optimizer.stats = {
        totalBatches: 5,
        totalConversions: 25,
        totalVolume: 10.5,
        totalSaved: 0.21,
        averageBatchSize: 5,
        largestBatch: 8
      };
      
      const stats = optimizer.getStats();
      
      expect(stats.totalBatches).toBe(5);
      expect(stats.totalConversions).toBe(25);
      expect(stats.totalVolume).toBe(10.5);
      expect(stats.totalSaved).toBe(0.21);
      expect(stats.averageSavings).toBe('2.00%');
      expect(stats.largestBatch).toBe(8);
    });
    
    it('should calculate correct fee savings', () => {
      const scenarios = [
        {
          volume: 1000,
          standardFee: 20,    // 2% standard
          optimizedFee: 15,   // 1.5% with optimization
          volumeDiscount: 0.5 // 0.05% volume discount
        },
        {
          volume: 10000,
          standardFee: 200,
          optimizedFee: 135,   // 1.35% with bulk + volume
          volumeDiscount: 15   // 0.15% volume discount
        }
      ];
      
      scenarios.forEach(scenario => {
        const savings = scenario.standardFee - scenario.optimizedFee + scenario.volumeDiscount;
        const savingsPercent = (savings / scenario.volume) * 100;
        
        expect(savingsPercent).toBeGreaterThan(0.5); // At least 0.5% saved
      });
    });
  });
});

// Integration test with external converter
describe('Bulk Optimization Integration', () => {
  let converter;
  let optimizer;
  
  beforeEach(() => {
    converter = new ExternalServiceConverter({
      bulkOptimizationEnabled: true
    });
  });
  
  it('should integrate with external service converter', async () => {
    // Small conversion should be queued
    const result1 = await converter.convert({
      fromCoin: 'ETH',
      toCoin: 'BTC',
      amount: 0.05,
      address: 'addr1',
      userId: 'user1',
      allowBatching: true
    });
    
    expect(result1.status).toBe('queued');
    expect(result1.id).toBeDefined();
    expect(result1.estimatedProcessingTime).toBeDefined();
    
    // Large conversion should process immediately
    converter.executeConversion = jest.fn().mockResolvedValue({
      success: true,
      transactionId: 'tx123'
    });
    
    const result2 = await converter.convert({
      fromCoin: 'ETH',
      toCoin: 'BTC',
      amount: 0.5, // Large amount
      address: 'addr2',
      userId: 'user2',
      allowBatching: true
    });
    
    expect(converter.executeConversion).toHaveBeenCalledWith(
      'ETH', 'BTC', 0.5, 'addr2', null
    );
  });
  
  it('should report bulk optimization stats', () => {
    converter.bulkOptimizer = {
      getStats: () => ({
        totalBatches: 10,
        totalConversions: 50,
        totalSaved: 0.5,
        averageSavings: '1.5%'
      })
    };
    
    const stats = converter.getStats();
    
    expect(stats.bulkOptimization).toBeDefined();
    expect(stats.bulkOptimization.enabled).toBe(true);
    expect(stats.bulkOptimization.totalBatches).toBe(10);
    expect(stats.bulkOptimization.totalConversions).toBe(50);
    expect(stats.bulkOptimization.averageSavings).toBe('1.5%');
  });
});

// Test fee comparison with and without bulk optimization
describe('Fee Comparison', () => {
  it('should demonstrate fee savings with bulk optimization', () => {
    const conversions = [
      { amount: 0.02, coin: 'ETH' },
      { amount: 0.03, coin: 'ETH' },
      { amount: 0.04, coin: 'ETH' },
      { amount: 0.05, coin: 'ETH' },
      { amount: 0.06, coin: 'ETH' }
    ];
    
    const totalAmount = conversions.reduce((sum, c) => sum + c.amount, 0);
    
    // Without bulk optimization
    const individualFees = conversions.map(c => c.amount * 0.002); // 0.2% each
    const totalIndividualFees = individualFees.reduce((sum, f) => sum + f, 0);
    
    // With bulk optimization
    const bulkFee = totalAmount * 0.0015; // 0.15% for bulk
    const volumeDiscount = totalAmount * 0.0005; // 0.05% volume discount
    const totalBulkCost = bulkFee - volumeDiscount;
    
    // Calculate savings
    const savings = totalIndividualFees - totalBulkCost;
    const savingsPercent = (savings / totalAmount) * 100;
    
    expect(totalBulkCost).toBeLessThan(totalIndividualFees);
    expect(savingsPercent).toBeGreaterThan(0.05); // At least 0.05% saved
    
    console.log(`
      Bulk Optimization Savings:
      - Total Amount: ${totalAmount} ETH
      - Individual Fees: ${totalIndividualFees.toFixed(6)} ETH (${(totalIndividualFees/totalAmount*100).toFixed(3)}%)
      - Bulk Fees: ${totalBulkCost.toFixed(6)} ETH (${(totalBulkCost/totalAmount*100).toFixed(3)}%)
      - Saved: ${savings.toFixed(6)} ETH (${savingsPercent.toFixed(3)}%)
    `);
  });
});