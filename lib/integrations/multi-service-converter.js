/**
 * Multi-Service Converter
 * Manages multiple conversion services simultaneously for redundancy
 * 
 * Features:
 * - Parallel service queries
 * - Load balancing
 * - Automatic failover
 * - Service health tracking
 * - Rate comparison
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { ExternalServiceConverter } from './external-service-converter.js';
import { ServiceFailoverManager } from './service-failover-manager.js';

const logger = createLogger('MultiServiceConverter');

/**
 * Service priority levels
 */
export const ServicePriority = {
  PRIMARY: 1,
  SECONDARY: 2,
  BACKUP: 3,
  EMERGENCY: 4
};

/**
 * Multi-Service Converter
 */
export class MultiServiceConverter extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Service configuration
      services: config.services || [
        { id: 'btcpay_lightning', priority: ServicePriority.PRIMARY, weight: 0.4 },
        { id: 'simpleswap', priority: ServicePriority.PRIMARY, weight: 0.3 },
        { id: 'changenow', priority: ServicePriority.PRIMARY, weight: 0.3 },
        { id: 'coinpayments', priority: ServicePriority.SECONDARY, weight: 0.5 },
        { id: 'coingate', priority: ServicePriority.SECONDARY, weight: 0.5 },
        { id: 'binance', priority: ServicePriority.BACKUP, weight: 0.6 },
        { id: 'kraken', priority: ServicePriority.BACKUP, weight: 0.4 }
      ],
      
      // Operation settings
      parallelQueries: config.parallelQueries !== false,
      maxParallelRequests: config.maxParallelRequests || 3,
      requestTimeout: config.requestTimeout || 5000,
      
      // Load balancing
      loadBalancing: config.loadBalancing || 'weighted', // weighted, round-robin, least-used
      rateComparison: config.rateComparison !== false,
      
      // Failover settings
      autoFailover: config.autoFailover !== false,
      maxServiceFailures: config.maxServiceFailures || 3,
      serviceRecoveryTime: config.serviceRecoveryTime || 300000, // 5 minutes
      
      // Rate optimization
      alwaysUseBestRate: config.alwaysUseBestRate || false,
      maxRateDifference: config.maxRateDifference || 0.02, // 2% max difference
      
      // Monitoring
      healthCheckInterval: config.healthCheckInterval || 60000,
      metricsEnabled: config.metricsEnabled !== false
    };
    
    // Service instances
    this.servicePool = new Map();
    this.serviceMetrics = new Map();
    this.failureTracking = new Map();
    
    // Components
    this.externalConverter = null;
    this.failoverManager = null;
    
    // Statistics
    this.stats = {
      totalConversions: 0,
      serviceUsage: {},
      failovers: 0,
      averageResponseTime: 0
    };
    
    // Initialize services
    this.initialize();
  }
  
  /**
   * Initialize multi-service converter
   */
  async initialize() {
    // Initialize external converter
    this.externalConverter = new ExternalServiceConverter({
      bulkOptimizationEnabled: true,
      preferNoKYC: true
    });
    
    // Initialize failover manager
    this.failoverManager = new ServiceFailoverManager({
      fallbackOrder: this.config.services.map(s => s.id),
      healthCheckInterval: this.config.healthCheckInterval
    });
    
    // Register services
    for (const service of this.config.services) {
      this.registerService(service);
    }
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    logger.info('Multi-service converter initialized with', {
      services: this.config.services.length,
      loadBalancing: this.config.loadBalancing
    });
  }
  
  /**
   * Register a service
   */
  registerService(serviceConfig) {
    const { id, priority, weight } = serviceConfig;
    
    this.servicePool.set(id, {
      id,
      priority,
      weight,
      available: true,
      failures: 0,
      lastFailure: null,
      totalRequests: 0,
      successfulRequests: 0,
      averageResponseTime: 0
    });
    
    this.serviceMetrics.set(id, {
      responseTime: [],
      successRate: 1.0,
      lastCheck: Date.now()
    });
    
    // Register with failover manager
    this.failoverManager.registerService(id, serviceConfig);
  }
  
  /**
   * Convert currency using multiple services
   */
  async convert(params) {
    const { fromCoin, toCoin, amount, address, userId, preferredService } = params;
    
    logger.info(`Multi-service conversion: ${amount} ${fromCoin} to ${toCoin}`);
    
    // If preferred service specified and available, use it
    if (preferredService && this.isServiceAvailable(preferredService)) {
      return await this.convertWithService(preferredService, params);
    }
    
    // Get available services
    const availableServices = this.getAvailableServices();
    
    if (availableServices.length === 0) {
      throw new Error('No conversion services available');
    }
    
    // Use parallel queries for rate comparison
    if (this.config.parallelQueries && this.config.rateComparison) {
      return await this.convertWithBestRate(availableServices, params);
    }
    
    // Use load balancing for single service selection
    const selectedService = this.selectService(availableServices);
    return await this.convertWithService(selectedService.id, params);
  }
  
  /**
   * Convert using the service with best rate
   */
  async convertWithBestRate(services, params) {
    const { fromCoin, toCoin, amount } = params;
    
    // Query multiple services in parallel
    const serviceSubset = services
      .filter(s => s.priority <= ServicePriority.SECONDARY)
      .slice(0, this.config.maxParallelRequests);
    
    const ratePromises = serviceSubset.map(service => 
      this.getServiceRate(service.id, fromCoin, toCoin, amount)
        .then(rate => ({ service: service.id, rate, error: null }))
        .catch(error => ({ service: service.id, rate: null, error }))
    );
    
    // Wait for all rate queries with timeout
    const rateResults = await Promise.race([
      Promise.all(ratePromises),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Rate query timeout')), this.config.requestTimeout)
      )
    ]);
    
    // Filter successful rates
    const validRates = rateResults
      .filter(r => r.rate && !r.error)
      .sort((a, b) => b.rate.effectiveRate - a.rate.effectiveRate);
    
    if (validRates.length === 0) {
      throw new Error('No valid rates available');
    }
    
    // Use best rate service
    const bestRate = validRates[0];
    logger.info(`Selected ${bestRate.service} with best rate:`, bestRate.rate);
    
    try {
      const result = await this.convertWithService(bestRate.service, params);
      
      // Update metrics
      this.updateServiceMetrics(bestRate.service, true, Date.now());
      
      return result;
      
    } catch (error) {
      logger.error(`Conversion failed with ${bestRate.service}:`, error);
      
      // Try next best service
      if (validRates.length > 1) {
        return await this.convertWithService(validRates[1].service, params);
      }
      
      throw error;
    }
  }
  
  /**
   * Convert using specific service
   */
  async convertWithService(serviceId, params) {
    const startTime = Date.now();
    
    try {
      // Mark service as in-use
      this.incrementServiceUsage(serviceId);
      
      // Execute conversion
      const result = await this.externalConverter.convert({
        ...params,
        preferredService: serviceId
      });
      
      // Update success metrics
      this.updateServiceMetrics(serviceId, true, Date.now() - startTime);
      
      return result;
      
    } catch (error) {
      // Update failure metrics
      this.updateServiceMetrics(serviceId, false, Date.now() - startTime);
      this.handleServiceFailure(serviceId, error);
      
      // Attempt failover if enabled
      if (this.config.autoFailover) {
        return await this.attemptFailover(params, serviceId);
      }
      
      throw error;
    }
  }
  
  /**
   * Get service rate
   */
  async getServiceRate(serviceId, fromCoin, toCoin, amount) {
    return await this.externalConverter.getServiceRate(serviceId, fromCoin, toCoin, amount);
  }
  
  /**
   * Select service based on load balancing strategy
   */
  selectService(availableServices) {
    switch (this.config.loadBalancing) {
      case 'weighted':
        return this.selectWeightedService(availableServices);
        
      case 'round-robin':
        return this.selectRoundRobinService(availableServices);
        
      case 'least-used':
        return this.selectLeastUsedService(availableServices);
        
      default:
        return availableServices[0];
    }
  }
  
  /**
   * Select service using weighted random selection
   */
  selectWeightedService(services) {
    const totalWeight = services.reduce((sum, s) => sum + s.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const service of services) {
      random -= service.weight;
      if (random <= 0) {
        return service;
      }
    }
    
    return services[0];
  }
  
  /**
   * Select service using round-robin
   */
  selectRoundRobinService(services) {
    if (!this.lastSelectedIndex) {
      this.lastSelectedIndex = 0;
    }
    
    const selected = services[this.lastSelectedIndex % services.length];
    this.lastSelectedIndex++;
    
    return selected;
  }
  
  /**
   * Select least used service
   */
  selectLeastUsedService(services) {
    return services.reduce((least, service) => {
      const leastRequests = this.servicePool.get(least.id).totalRequests;
      const serviceRequests = this.servicePool.get(service.id).totalRequests;
      return serviceRequests < leastRequests ? service : least;
    });
  }
  
  /**
   * Get available services
   */
  getAvailableServices() {
    return Array.from(this.servicePool.values())
      .filter(s => s.available && s.failures < this.config.maxServiceFailures)
      .sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Check if service is available
   */
  isServiceAvailable(serviceId) {
    const service = this.servicePool.get(serviceId);
    return service && service.available && service.failures < this.config.maxServiceFailures;
  }
  
  /**
   * Handle service failure
   */
  handleServiceFailure(serviceId, error) {
    const service = this.servicePool.get(serviceId);
    if (!service) return;
    
    service.failures++;
    service.lastFailure = Date.now();
    
    logger.warn(`Service ${serviceId} failure #${service.failures}:`, error.message);
    
    // Disable service if too many failures
    if (service.failures >= this.config.maxServiceFailures) {
      service.available = false;
      logger.error(`Service ${serviceId} disabled after ${service.failures} failures`);
      
      // Schedule recovery check
      setTimeout(() => {
        this.checkServiceRecovery(serviceId);
      }, this.config.serviceRecoveryTime);
    }
    
    this.emit('service:failure', { serviceId, failures: service.failures });
  }
  
  /**
   * Attempt failover to another service
   */
  async attemptFailover(params, failedService) {
    logger.info(`Attempting failover from ${failedService}`);
    
    const availableServices = this.getAvailableServices()
      .filter(s => s.id !== failedService);
    
    if (availableServices.length === 0) {
      throw new Error('No failover services available');
    }
    
    // Try services in priority order
    for (const service of availableServices) {
      try {
        const result = await this.convertWithService(service.id, params);
        
        this.stats.failovers++;
        this.emit('failover:success', {
          from: failedService,
          to: service.id
        });
        
        return result;
        
      } catch (error) {
        logger.error(`Failover to ${service.id} failed:`, error);
        continue;
      }
    }
    
    throw new Error('All failover attempts failed');
  }
  
  /**
   * Update service metrics
   */
  updateServiceMetrics(serviceId, success, responseTime) {
    const service = this.servicePool.get(serviceId);
    const metrics = this.serviceMetrics.get(serviceId);
    
    if (!service || !metrics) return;
    
    // Update request count
    service.totalRequests++;
    if (success) {
      service.successfulRequests++;
    }
    
    // Update response time
    metrics.responseTime.push(responseTime);
    if (metrics.responseTime.length > 100) {
      metrics.responseTime.shift();
    }
    
    // Calculate averages
    service.averageResponseTime = 
      metrics.responseTime.reduce((a, b) => a + b, 0) / metrics.responseTime.length;
    
    metrics.successRate = service.successfulRequests / service.totalRequests;
    
    // Update usage statistics
    if (!this.stats.serviceUsage[serviceId]) {
      this.stats.serviceUsage[serviceId] = 0;
    }
    this.stats.serviceUsage[serviceId]++;
  }
  
  /**
   * Increment service usage counter
   */
  incrementServiceUsage(serviceId) {
    const service = this.servicePool.get(serviceId);
    if (service) {
      service.totalRequests++;
    }
  }
  
  /**
   * Check service recovery
   */
  async checkServiceRecovery(serviceId) {
    const service = this.servicePool.get(serviceId);
    if (!service || service.available) return;
    
    try {
      // Test service with small amount
      await this.getServiceRate(serviceId, 'ETH', 'BTC', 0.01);
      
      // Service recovered
      service.available = true;
      service.failures = 0;
      
      logger.info(`Service ${serviceId} recovered`);
      this.emit('service:recovered', { serviceId });
      
    } catch (error) {
      logger.warn(`Service ${serviceId} still unavailable`);
      
      // Schedule another check
      setTimeout(() => {
        this.checkServiceRecovery(serviceId);
      }, this.config.serviceRecoveryTime);
    }
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    // Use failover manager for health checks
    this.failoverManager.start();
    
    // Additional monitoring
    setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckInterval);
  }
  
  /**
   * Perform health checks on all services
   */
  async performHealthChecks() {
    const services = Array.from(this.servicePool.values());
    
    for (const service of services) {
      if (service.available) {
        try {
          await this.getServiceRate(service.id, 'BTC', 'USDT', 1);
          // Reset failure count on successful check
          if (service.failures > 0) {
            service.failures = Math.max(0, service.failures - 1);
          }
        } catch (error) {
          // Ignore health check failures for available services
        }
      }
    }
  }
  
  /**
   * Get service statistics
   */
  getStats() {
    const serviceStats = {};
    
    for (const [id, service] of this.servicePool) {
      const metrics = this.serviceMetrics.get(id);
      
      serviceStats[id] = {
        available: service.available,
        priority: service.priority,
        weight: service.weight,
        totalRequests: service.totalRequests,
        successRate: metrics.successRate,
        averageResponseTime: service.averageResponseTime,
        failures: service.failures,
        lastFailure: service.lastFailure
      };
    }
    
    return {
      ...this.stats,
      totalConversions: Object.values(this.stats.serviceUsage)
        .reduce((sum, count) => sum + count, 0),
      services: serviceStats,
      healthyServices: Array.from(this.servicePool.values())
        .filter(s => s.available).length,
      loadBalancing: this.config.loadBalancing
    };
  }
}

export default MultiServiceConverter;