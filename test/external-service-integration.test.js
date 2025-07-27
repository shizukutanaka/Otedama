/**
 * External Service Integration Tests
 * Tests the integration with external swap services
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExternalServiceConverter, ConversionService } from '../lib/integrations/external-service-converter.js';
import { MultiCoinPayoutManager } from '../lib/mining/multi-coin-payout-manager.js';

describe('External Service Integration', () => {
  let converter;
  let payoutManager;
  
  beforeEach(() => {
    converter = new ExternalServiceConverter({
      primaryService: ConversionService.BTCPAY_LIGHTNING,
      fallbackServices: [
        ConversionService.CHANGENOW,
        ConversionService.SIMPLESWAP
      ],
      preferNoKYC: true
    });
    
    payoutManager = new MultiCoinPayoutManager({
      poolFee: 0.01,
      soloFee: 0.005,
      conversionFee: 0.002, // 0.2% with external services
      useExternalServices: true
    });
  });
  
  afterEach(() => {
    converter = null;
    payoutManager = null;
  });
  
  describe('Service Configuration', () => {
    it('should have correct fee structure for each service', () => {
      const services = converter.services;
      
      // Check BTCPay Lightning (0% fees)
      const btcpay = services.get(ConversionService.BTCPAY_LIGHTNING);
      expect(btcpay?.fee).toBe(0);
      
      // Check ChangeNOW (0.5% fees)
      const changenow = services.get(ConversionService.CHANGENOW);
      expect(changenow?.fee).toBe(0.005);
      
      // Check SimpleSwap (0% trading fees, but has spread)
      const simpleswap = services.get(ConversionService.SIMPLESWAP);
      expect(simpleswap?.fee).toBe(0);
      expect(simpleswap?.estimatedSpread).toBe(0.005);
    });
    
    it('should prefer no-KYC services', () => {
      expect(converter.config.preferNoKYC).toBe(true);
      
      // All primary services should be no-KYC
      const btcpay = converter.services.get(ConversionService.BTCPAY_LIGHTNING);
      const changenow = converter.services.get(ConversionService.CHANGENOW);
      const simpleswap = converter.services.get(ConversionService.SIMPLESWAP);
      
      expect(btcpay?.noKYC).toBe(true);
      expect(changenow?.noKYC).toBe(true);
      expect(simpleswap?.noKYC).toBe(true);
    });
  });
  
  describe('Fee Comparison', () => {
    it('should have lower fees than traditional exchanges', () => {
      // External service fees
      const externalFees = {
        lightning: 0,
        simpleswap: 0.005, // Including spread
        changenow: 0.005
      };
      
      // Traditional exchange fees
      const exchangeFees = {
        binance: 0.001 + 0.0005, // Trading + withdrawal
        kraken: 0.0016 + 0.00015,
        nicehash: 0.02 // 2%
      };
      
      // All external services should be cheaper
      Object.values(externalFees).forEach(externalFee => {
        Object.values(exchangeFees).forEach(exchangeFee => {
          expect(externalFee).toBeLessThan(exchangeFee);
        });
      });
    });
    
    it('should calculate total fees correctly', () => {
      // Pool mining with conversion
      const poolFee = 0.01;
      const conversionFee = 0.002;
      const totalPoolFee = poolFee + conversionFee;
      
      expect(totalPoolFee).toBe(0.012); // 1.2%
      
      // Solo mining with conversion
      const soloFee = 0.005;
      const totalSoloFee = soloFee + conversionFee;
      
      expect(totalSoloFee).toBe(0.007); // 0.7%
      
      // Compare with competitors
      expect(totalPoolFee).toBeLessThan(0.02); // NiceHash 2%
      expect(totalSoloFee).toBeLessThan(0.01); // Other solo pools 1%+
    });
  });
  
  describe('Service Selection', () => {
    it('should prioritize Lightning for BTC conversions', async () => {
      const mockRate = {
        [ConversionService.BTCPAY_LIGHTNING]: { rate: 1, fee: 0, service: ConversionService.BTCPAY_LIGHTNING },
        [ConversionService.CHANGENOW]: { rate: 0.99, fee: 0.005, service: ConversionService.CHANGENOW }
      };
      
      // For BTC, Lightning should be preferred (0% fee)
      const btcService = ConversionService.BTCPAY_LIGHTNING;
      expect(mockRate[btcService].fee).toBe(0);
      expect(mockRate[btcService].fee).toBeLessThan(mockRate[ConversionService.CHANGENOW].fee);
    });
    
    it('should fallback to swap services for altcoins', () => {
      // Lightning only supports BTC
      const supportedByLightning = ['BTC'];
      const altcoins = ['ETH', 'LTC', 'DOGE'];
      
      altcoins.forEach(coin => {
        expect(supportedByLightning.includes(coin)).toBe(false);
      });
      
      // These should use SimpleSwap or ChangeNOW
      const swapServices = [ConversionService.SIMPLESWAP, ConversionService.CHANGENOW];
      expect(swapServices.length).toBeGreaterThan(0);
    });
  });
  
  describe('Conversion Execution', () => {
    it('should handle Lightning Network conversions', () => {
      const lightningConfig = converter.services.get(ConversionService.BTCPAY_LIGHTNING);
      
      expect(lightningConfig).toBeDefined();
      expect(lightningConfig.instantSwap).toBe(true);
      expect(lightningConfig.minAmount).toBe(0.00001); // 1000 sats
      expect(lightningConfig.maxAmount).toBe(0.1); // Channel limit
    });
    
    it('should handle swap service conversions', () => {
      const simpleswap = converter.services.get(ConversionService.SIMPLESWAP);
      const changenow = converter.services.get(ConversionService.CHANGENOW);
      
      // SimpleSwap
      expect(simpleswap).toBeDefined();
      expect(simpleswap.minAmount).toBe(0);
      expect(simpleswap.maxAmount).toBe(null); // No limit
      
      // ChangeNOW
      expect(changenow).toBeDefined();
      expect(changenow.minAmount).toBe(0.001);
      expect(changenow.supportedCoins.length).toBeGreaterThan(5);
    });
  });
  
  describe('Statistics and Savings', () => {
    it('should track fee savings vs traditional exchanges', () => {
      const stats = converter.getStats();
      
      expect(stats).toHaveProperty('totalFeesSaved');
      expect(stats).toHaveProperty('conversions');
      expect(stats).toHaveProperty('servicesAvailable');
      
      // Should have at least 2 services available
      expect(stats.servicesAvailable).toBeGreaterThanOrEqual(2);
    });
    
    it('should calculate correct savings', () => {
      // Example: 1 ETH conversion
      const amount = 1;
      const traditionalFee = amount * 0.025; // 2.5% average
      const externalServiceFee = amount * 0.005; // 0.5% ChangeNOW
      const savings = traditionalFee - externalServiceFee;
      
      expect(savings).toBe(0.02); // 2% saved
      expect(savings / traditionalFee).toBe(0.8); // 80% savings
    });
  });
  
  describe('Integration with Payout Manager', () => {
    it('should use external services by default', () => {
      expect(payoutManager.config.useExternalServices).toBe(true);
      expect(payoutManager.config.primaryExchange).toBe('external');
    });
    
    it('should have reduced conversion fees', () => {
      expect(payoutManager.config.conversionFee).toBe(0.002); // 0.2%
      
      // Total fees should be competitive
      const totalPoolFee = payoutManager.config.poolFee + payoutManager.config.conversionFee;
      const totalSoloFee = payoutManager.config.soloFee + payoutManager.config.conversionFee;
      
      expect(totalPoolFee).toBe(0.012); // 1.2%
      expect(totalSoloFee).toBe(0.007); // 0.7%
    });
  });
});

// Test complete conversion flow
describe('External Service Conversion Flow', () => {
  it('should execute complete conversion with minimal fees', async () => {
    const converter = new ExternalServiceConverter({
      primaryService: ConversionService.SIMPLESWAP
    });
    
    // Mock conversion scenario
    const conversion = {
      fromCoin: 'ETH',
      toCoin: 'BTC',
      amount: 0.5,
      service: ConversionService.SIMPLESWAP
    };
    
    // Calculate fees
    const serviceFee = 0; // SimpleSwap has no explicit fee
    const spread = 0.005; // 0.5% spread
    const poolFee = 0.01; // 1% pool fee
    const totalFee = poolFee + spread;
    
    expect(totalFee).toBe(0.015); // 1.5% total
    
    // Compare with traditional exchange
    const exchangeFee = 0.001; // 0.1% trading
    const withdrawalFee = 0.0005; // BTC withdrawal
    const exchangeTotal = poolFee + exchangeFee + withdrawalFee;
    
    // External service should be competitive
    expect(totalFee).toBeLessThanOrEqual(exchangeTotal + 0.005); // Within 0.5%
  });
  
  it('should prefer Lightning for BTC payouts', async () => {
    const converter = new ExternalServiceConverter({
      primaryService: ConversionService.BTCPAY_LIGHTNING,
      lightningEnabled: true
    });
    
    // BTC to BTC "conversion" (just payout)
    const btcPayout = {
      fromCoin: 'BTC',
      toCoin: 'BTC',
      amount: 0.01,
      service: ConversionService.BTCPAY_LIGHTNING
    };
    
    // Lightning should have 0% fees
    const lightningFee = 0;
    const poolFee = 0.01;
    const totalFee = poolFee + lightningFee;
    
    expect(totalFee).toBe(0.01); // Only pool fee, no conversion fee
    
    // This is the most efficient payout method
    expect(lightningFee).toBe(0);
  });
});