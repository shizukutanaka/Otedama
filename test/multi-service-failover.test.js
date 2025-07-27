/**
 * Multi-Service Failover Tests
 * Tests the multi-service converter with failover capabilities
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MultiServiceConverter, ServicePriority } from '../lib/integrations/multi-service-converter.js';
import { ConversionService } from '../lib/integrations/external-service-converter.js';

describe('Multi-Service Failover', () => {
  let converter;
  
  beforeEach(() => {
    converter = new MultiServiceConverter({
      services: [
        { id: ConversionService.BTCPAY_LIGHTNING, priority: 1, weight: 0.4 },
        { id: ConversionService.SIMPLESWAP, priority: 1, weight: 0.3 },
        { id: ConversionService.CHANGENOW, priority: 1, weight: 0.3 },
        { id: ConversionService.COINPAYMENTS, priority: 2, weight: 1.0 }
      ],
      parallelQueries: true,
      maxParallelRequests: 3,
      autoFailover: true,
      maxServiceFailures: 3
    });
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('Service Selection', () => {
    it('should select services based on weighted distribution', () => {
      const services = [
        { id: 'service1', weight: 0.5 },
        { id: 'service2', weight: 0.3 },
        { id: 'service3', weight: 0.2 }
      ];
      
      // Test distribution over many iterations
      const selections = {};
      for (let i = 0; i < 10000; i++) {
        const selected = converter.selectWeightedService(services);
        selections[selected.id] = (selections[selected.id] || 0) + 1;
      }
      
      // Check distribution is roughly correct (within 5%)
      expect(selections.service1 / 10000).toBeCloseTo(0.5, 1);
      expect(selections.service2 / 10000).toBeCloseTo(0.3, 1);
      expect(selections.service3 / 10000).toBeCloseTo(0.2, 1);
    });
    
    it('should respect service priority levels', () => {
      const available = converter.getAvailableServices();
      
      // Primary services should come first
      const primaryServices = available.filter(s => s.priority === 1);
      const secondaryServices = available.filter(s => s.priority === 2);
      
      expect(primaryServices.length).toBe(3);
      expect(secondaryServices.length).toBe(1);
      
      // Check ordering
      for (let i = 0; i < primaryServices.length; i++) {
        expect(available[i].priority).toBe(1);
      }
    });
    
    it('should exclude failed services', () => {
      // Mark a service as failed
      const btcpayService = converter.servicePool.get(ConversionService.BTCPAY_LIGHTNING);
      btcpayService.failures = 3;
      btcpayService.available = false;
      
      const available = converter.getAvailableServices();
      const btcpayAvailable = available.find(s => s.id === ConversionService.BTCPAY_LIGHTNING);
      
      expect(btcpayAvailable).toBeUndefined();
      expect(available.length).toBe(3); // One service excluded
    });
  });
  
  describe('Parallel Rate Queries', () => {
    it('should query multiple services in parallel', async () => {
      const mockRates = {
        [ConversionService.BTCPAY_LIGHTNING]: { rate: 0.0654, fee: 0, effectiveRate: 0.0654 },
        [ConversionService.SIMPLESWAP]: { rate: 0.0652, fee: 0, effectiveRate: 0.0649 },
        [ConversionService.CHANGENOW]: { rate: 0.0651, fee: 0.005, effectiveRate: 0.0648 }
      };
      
      // Mock getServiceRate
      converter.getServiceRate = jest.fn((serviceId) => {
        return Promise.resolve(mockRates[serviceId]);
      });
      
      const services = converter.getAvailableServices().slice(0, 3);
      const result = await converter.convertWithBestRate(services, {
        fromCoin: 'ETH',
        toCoin: 'BTC',
        amount: 1
      });
      
      // Should have queried all 3 services
      expect(converter.getServiceRate).toHaveBeenCalledTimes(3);
      
      // Should select best rate (BTCPay)
      expect(result).toBeDefined();
    });
    
    it('should handle service timeouts gracefully', async () => {
      // Mock one service timing out
      converter.getServiceRate = jest.fn((serviceId) => {
        if (serviceId === ConversionService.SIMPLESWAP) {
          return new Promise((resolve) => setTimeout(resolve, 10000)); // Timeout
        }
        return Promise.resolve({ rate: 0.065, fee: 0.005, effectiveRate: 0.0645 });
      });
      
      converter.config.requestTimeout = 1000; // 1 second timeout
      
      const services = converter.getAvailableServices();
      
      // This should timeout but not throw
      await expect(
        converter.convertWithBestRate(services, {
          fromCoin: 'ETH',
          toCoin: 'BTC',
          amount: 1
        })
      ).rejects.toThrow('Rate query timeout');
    });
  });
  
  describe('Failover Mechanism', () => {
    it('should failover to next service on failure', async () => {
      const params = {
        fromCoin: 'ETH',
        toCoin: 'BTC',
        amount: 0.5,
        address: 'bc1qtest'
      };
      
      // Mock first service failing
      converter.externalConverter = {
        convert: jest.fn()
          .mockRejectedValueOnce(new Error('Service unavailable'))
          .mockResolvedValueOnce({ success: true, service: ConversionService.SIMPLESWAP })
      };
      
      const result = await converter.convertWithService(ConversionService.BTCPAY_LIGHTNING, params);
      
      expect(result.success).toBe(true);
      expect(result.service).toBe(ConversionService.SIMPLESWAP);
    });
    
    it('should track service failures', () => {
      converter.handleServiceFailure(ConversionService.BTCPAY_LIGHTNING, new Error('Test error'));
      
      const service = converter.servicePool.get(ConversionService.BTCPAY_LIGHTNING);
      expect(service.failures).toBe(1);
      expect(service.lastFailure).toBeDefined();
      expect(service.available).toBe(true); // Still available after 1 failure
      
      // Fail it more times
      converter.handleServiceFailure(ConversionService.BTCPAY_LIGHTNING, new Error('Test error'));
      converter.handleServiceFailure(ConversionService.BTCPAY_LIGHTNING, new Error('Test error'));
      
      expect(service.failures).toBe(3);
      expect(service.available).toBe(false); // Disabled after 3 failures
    });
    
    it('should attempt all available services before failing', async () => {
      const params = {
        fromCoin: 'ETH',
        toCoin: 'BTC',
        amount: 0.5,
        address: 'bc1qtest'
      };
      
      // Mock all services failing
      converter.convertWithService = jest.fn()
        .mockRejectedValue(new Error('Service unavailable'));
      
      await expect(
        converter.attemptFailover(params, ConversionService.BTCPAY_LIGHTNING)
      ).rejects.toThrow('All failover attempts failed');
      
      // Should have tried remaining services
      expect(converter.convertWithService).toHaveBeenCalledTimes(3);
    });
  });
  
  describe('Service Recovery', () => {
    it('should check service recovery after failure', async () => {
      const serviceId = ConversionService.BTCPAY_LIGHTNING;
      const service = converter.servicePool.get(serviceId);
      
      // Mark service as failed
      service.available = false;
      service.failures = 3;
      
      // Mock successful health check
      converter.getServiceRate = jest.fn().mockResolvedValue({
        rate: 0.065,
        fee: 0,
        effectiveRate: 0.065
      });
      
      await converter.checkServiceRecovery(serviceId);
      
      expect(service.available).toBe(true);
      expect(service.failures).toBe(0);
    });
    
    it('should schedule retry if recovery fails', async () => {
      jest.useFakeTimers();
      
      const serviceId = ConversionService.BTCPAY_LIGHTNING;
      const service = converter.servicePool.get(serviceId);
      
      service.available = false;
      
      // Mock failed health check
      converter.getServiceRate = jest.fn().mockRejectedValue(new Error('Still down'));
      
      await converter.checkServiceRecovery(serviceId);
      
      expect(service.available).toBe(false);
      
      // Should schedule another check
      expect(setTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        converter.config.serviceRecoveryTime
      );
      
      jest.useRealTimers();
    });
  });
  
  describe('Load Balancing', () => {
    it('should support round-robin distribution', () => {
      converter.config.loadBalancing = 'round-robin';
      const services = converter.getAvailableServices();
      
      const selections = [];
      for (let i = 0; i < services.length * 2; i++) {
        selections.push(converter.selectService(services).id);
      }
      
      // Should cycle through all services
      expect(selections[0]).toBe(selections[services.length]);
      expect(selections[1]).toBe(selections[services.length + 1]);
    });
    
    it('should support least-used selection', () => {
      converter.config.loadBalancing = 'least-used';
      
      // Set different request counts
      converter.servicePool.get(ConversionService.BTCPAY_LIGHTNING).totalRequests = 100;
      converter.servicePool.get(ConversionService.SIMPLESWAP).totalRequests = 50;
      converter.servicePool.get(ConversionService.CHANGENOW).totalRequests = 75;
      
      const services = converter.getAvailableServices();
      const selected = converter.selectService(services);
      
      expect(selected.id).toBe(ConversionService.SIMPLESWAP); // Least used
    });
  });
  
  describe('Metrics and Monitoring', () => {
    it('should track service metrics', () => {
      converter.updateServiceMetrics(ConversionService.BTCPAY_LIGHTNING, true, 250);
      converter.updateServiceMetrics(ConversionService.BTCPAY_LIGHTNING, true, 300);
      converter.updateServiceMetrics(ConversionService.BTCPAY_LIGHTNING, false, 5000);
      
      const service = converter.servicePool.get(ConversionService.BTCPAY_LIGHTNING);
      const metrics = converter.serviceMetrics.get(ConversionService.BTCPAY_LIGHTNING);
      
      expect(service.totalRequests).toBe(3);
      expect(service.successfulRequests).toBe(2);
      expect(metrics.successRate).toBeCloseTo(0.667, 2);
      expect(service.averageResponseTime).toBeGreaterThan(0);
    });
    
    it('should provide comprehensive statistics', () => {
      // Simulate some activity
      converter.stats.serviceUsage[ConversionService.BTCPAY_LIGHTNING] = 50;
      converter.stats.serviceUsage[ConversionService.SIMPLESWAP] = 30;
      converter.stats.serviceUsage[ConversionService.CHANGENOW] = 20;
      converter.stats.failovers = 5;
      
      const stats = converter.getStats();
      
      expect(stats.totalConversions).toBe(100);
      expect(stats.failovers).toBe(5);
      expect(stats.healthyServices).toBe(4);
      expect(stats.services).toBeDefined();
      expect(Object.keys(stats.services).length).toBe(4);
    });
  });
});

// Integration test
describe('Multi-Service Integration', () => {
  it('should handle real conversion with failover', async () => {
    const converter = new MultiServiceConverter({
      services: [
        { id: ConversionService.SIMPLESWAP, priority: 1, weight: 0.5 },
        { id: ConversionService.CHANGENOW, priority: 1, weight: 0.5 }
      ],
      autoFailover: true,
      alwaysUseBestRate: true
    });
    
    // Mock the external converter
    converter.externalConverter = {
      getAllServiceRates: jest.fn().mockResolvedValue([
        { service: ConversionService.SIMPLESWAP, rate: 0.0652, fee: 0, effectiveRate: 0.0649 },
        { service: ConversionService.CHANGENOW, rate: 0.0651, fee: 0.005, effectiveRate: 0.0648 }
      ]),
      convert: jest.fn().mockResolvedValue({
        success: true,
        transactionId: 'tx123',
        service: ConversionService.SIMPLESWAP
      })
    };
    
    const result = await converter.convert({
      fromCoin: 'ETH',
      toCoin: 'BTC',
      amount: 1,
      address: 'bc1qtest',
      userId: 'user123'
    });
    
    expect(result.success).toBe(true);
    expect(result.service).toBe(ConversionService.SIMPLESWAP);
  });
});