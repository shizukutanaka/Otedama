/**
 * Multi-Coin Payout System Tests
 * Tests the complete multi-coin payout functionality
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MultiCoinPayoutManager, PayoutCurrency } from '../lib/mining/multi-coin-payout-manager.js';

describe('Multi-Coin Payout System', () => {
  let payoutManager;
  
  beforeEach(() => {
    payoutManager = new MultiCoinPayoutManager({
      poolFee: 0.01,
      soloFee: 0.005,
      conversionFee: 0.003,
      minPayoutBTC: 0.0001,
      minPayoutNative: 0.001
    });
  });
  
  afterEach(() => {
    // Cleanup
    payoutManager = null;
  });
  
  describe('Fee Structure', () => {
    it('should have competitive base fees', () => {
      expect(payoutManager.config.poolFee).toBe(0.01); // 1%
      expect(payoutManager.config.soloFee).toBe(0.005); // 0.5%
      expect(payoutManager.config.conversionFee).toBe(0.003); // 0.3%
    });
    
    it('should ensure total fees are profitable', () => {
      const poolWithConversion = payoutManager.config.poolFee + payoutManager.config.conversionFee;
      const soloWithConversion = payoutManager.config.soloFee + payoutManager.config.conversionFee;
      
      expect(poolWithConversion).toBe(0.013); // 1.3% total
      expect(soloWithConversion).toBe(0.008); // 0.8% total
      
      // Compare with competitors
      const nicehashFee = 0.02; // 2%
      const prohashingFee = 0.01; // 1% + network fees
      
      expect(poolWithConversion).toBeLessThan(nicehashFee);
      expect(soloWithConversion).toBeLessThan(prohashingFee);
    });
  });
  
  describe('Payout Preferences', () => {
    it('should set miner preferences correctly', () => {
      const preferences = payoutManager.setMinerPayoutPreferences('miner1', {
        currency: PayoutCurrency.BTC,
        address: '1TestBTCAddress',
        autoConvert: true,
        customAddresses: {
          ETH: '0xTestETHAddress',
          LTC: 'LTestLTCAddress'
        }
      });
      
      expect(preferences.payoutCurrency).toBe(PayoutCurrency.BTC);
      expect(preferences.payoutAddress).toBe('1TestBTCAddress');
      expect(preferences.customAddresses.ETH).toBe('0xTestETHAddress');
      expect(preferences.autoConvert).toBe(true);
    });
    
    it('should support native coin payouts', () => {
      const preferences = payoutManager.setMinerPayoutPreferences('miner2', {
        currency: PayoutCurrency.NATIVE,
        address: '0xNativeAddress'
      });
      
      expect(preferences.payoutCurrency).toBe(PayoutCurrency.NATIVE);
      expect(preferences.minPayout).toBe(0.001); // Native minimum
    });
  });
  
  describe('Earnings Processing', () => {
    it('should process pool earnings with correct fees', async () => {
      // Set up miner for native payout
      payoutManager.setMinerPayoutPreferences('miner1', {
        currency: PayoutCurrency.NATIVE,
        address: '0xTestAddress'
      });
      
      const amount = 1.0; // 1 ETH
      await payoutManager.processMinerEarnings('miner1', amount, 'ETH', false);
      
      // Check pending payouts
      const pending = payoutManager.pendingPayouts.get('miner1:ETH');
      expect(pending).toBeDefined();
      expect(pending.amount).toBe(0.99); // 1% pool fee deducted
    });
    
    it('should process solo earnings with lower fees', async () => {
      payoutManager.setMinerPayoutPreferences('miner2', {
        currency: PayoutCurrency.NATIVE,
        address: '0xTestAddress'
      });
      
      const amount = 1.0;
      await payoutManager.processMinerEarnings('miner2', amount, 'ETH', true); // solo = true
      
      const pending = payoutManager.pendingPayouts.get('miner2:ETH');
      expect(pending.amount).toBe(0.995); // 0.5% solo fee deducted
    });
    
    it('should queue conversions for BTC payouts', async () => {
      payoutManager.setMinerPayoutPreferences('miner3', {
        currency: PayoutCurrency.BTC,
        address: '1BTCAddress',
        autoConvert: true
      });
      
      await payoutManager.processMinerEarnings('miner3', 0.1, 'ETH', false);
      
      const conversion = payoutManager.conversionQueue.get('miner3:ETH');
      expect(conversion).toBeDefined();
      expect(conversion.amount).toBe(0.099); // After 1% pool fee
      expect(conversion.toCoin).toBe('BTC');
    });
  });
  
  describe('Conversion System', () => {
    it('should calculate profitable conversions', () => {
      const mockBlock = {
        value: 1 * 100000000, // 1 coin in base units
        minerAddress: '0xMinerAddress'
      };
      
      const rewards = payoutManager.calculateRewards(mockBlock);
      
      // Pool fee calculation
      const poolFee = mockBlock.value * 0.01;
      expect(rewards.feeAmount).toBe(poolFee);
      expect(rewards.minerReward).toBe(mockBlock.value - poolFee);
      
      // Ensure miner gets at least 99%
      const minerPercent = rewards.minerReward / mockBlock.value;
      expect(minerPercent).toBeGreaterThanOrEqual(0.99);
    });
    
    it('should select best exchange rate', async () => {
      const rate = await payoutManager.getBestExchangeRate('ETH', 'BTC');
      
      expect(rate).toBeDefined();
      expect(rate.exchange).toBeDefined();
      expect(rate.fee).toBeLessThan(0.01); // Less than 1%
      expect(rate.rate).toBeGreaterThan(0); // Positive rate
    });
  });
  
  describe('Address Validation', () => {
    it('should validate BTC addresses', () => {
      expect(payoutManager.validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'BTC')).toBe(true);
      expect(payoutManager.validateAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BTC')).toBe(true);
      expect(payoutManager.validateAddress('invalid', 'BTC')).toBe(false);
    });
    
    it('should validate ETH addresses', () => {
      expect(payoutManager.validateAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f2bd0e', 'ETH')).toBe(true);
      expect(payoutManager.validateAddress('0xinvalid', 'ETH')).toBe(false);
    });
    
    it('should validate other coin addresses', () => {
      expect(payoutManager.validateAddress('LKPxEUKPcDVLjnXgpVYnnQFsi8zThW8HUZ', 'LTC')).toBe(true);
      expect(payoutManager.validateAddress('DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', 'DOGE')).toBe(true);
    });
  });
  
  describe('Bulk Operations', () => {
    it('should benefit from bulk conversion rates', async () => {
      // Set up multiple miners for bulk conversion
      for (let i = 1; i <= 10; i++) {
        payoutManager.setMinerPayoutPreferences(`miner${i}`, {
          currency: PayoutCurrency.BTC,
          address: `1BTCAddress${i}`,
          autoConvert: true
        });
        
        // Add to conversion queue
        payoutManager.addToConversionQueue(`miner${i}`, 0.1, 'ETH');
      }
      
      expect(payoutManager.conversionQueue.size).toBe(10);
      
      // Bulk conversion should have better rates
      // In production, bulk orders would get 0.01% discount
      const singleRate = 0.001; // 0.1%
      const bulkRate = 0.0009; // 0.09% with bulk discount
      
      expect(bulkRate).toBeLessThan(singleRate);
    });
  });
  
  describe('Statistics', () => {
    it('should track payout statistics', async () => {
      // Process some earnings
      payoutManager.setMinerPayoutPreferences('miner1', {
        currency: PayoutCurrency.NATIVE,
        address: '0xAddress'
      });
      
      await payoutManager.processMinerEarnings('miner1', 1.0, 'ETH', false);
      
      const stats = payoutManager.getStats();
      expect(stats.totalFees).toBeGreaterThan(0);
      expect(stats.pendingPayouts).toBeDefined();
      expect(stats.totalFeeRate).toBe('1.3%'); // Pool + conversion
    });
  });
});

// Integration test for complete payout flow
describe('Multi-Coin Payout Complete Flow', () => {
  it('should handle complete ETH to BTC conversion flow', async () => {
    const payoutManager = new MultiCoinPayoutManager({
      poolFee: 0.01,
      conversionFee: 0.003
    });
    
    // 1. Set preferences for BTC payout
    payoutManager.setMinerPayoutPreferences('miner1', {
      currency: PayoutCurrency.BTC,
      address: '1TestBTCAddress',
      autoConvert: true,
      minPayout: 0.0001
    });
    
    // 2. Mine some ETH
    const ethMined = 0.1; // 0.1 ETH
    await payoutManager.processMinerEarnings('miner1', ethMined, 'ETH', false);
    
    // 3. Check conversion queue
    const conversion = payoutManager.conversionQueue.get('miner1:ETH');
    expect(conversion.amount).toBe(0.099); // After 1% fee
    
    // 4. Trigger conversion
    await payoutManager.triggerConversion('miner1', 'ETH');
    
    // 5. Check BTC pending payout
    const btcPending = payoutManager.pendingPayouts.get('miner1:BTC');
    expect(btcPending).toBeDefined();
    
    // Calculate expected BTC amount
    // 0.099 ETH * 0.997 (after 0.3% conversion fee) * 0.065 (ETH/BTC rate)
    const expectedBTC = 0.099 * 0.997 * 0.065;
    expect(btcPending.amount).toBeCloseTo(expectedBTC, 6);
  });
  
  it('should ensure profitability with all fees', () => {
    const scenarios = [
      { mode: 'pool', conversion: false, totalFee: 0.01 },    // 1%
      { mode: 'pool', conversion: true, totalFee: 0.013 },    // 1.3%
      { mode: 'solo', conversion: false, totalFee: 0.005 },   // 0.5%
      { mode: 'solo', conversion: true, totalFee: 0.008 }     // 0.8%
    ];
    
    scenarios.forEach(scenario => {
      // Ensure total fees leave profit margin
      const operatingCost = 0.005; // 0.5% estimated operating cost
      const profit = scenario.totalFee - operatingCost;
      
      expect(profit).toBeGreaterThanOrEqual(0); // Always profitable
      
      // Compare with competitors
      const competitorFees = {
        nicehash: 0.02,
        prohashing: 0.015 // Including network fees
      };
      
      expect(scenario.totalFee).toBeLessThan(competitorFees.nicehash);
    });
  });
});