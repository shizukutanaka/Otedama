/**
 * Service Failover Manager
 * Handles automatic failover when external services are unavailable
 * 
 * Features:
 * - Health monitoring
 * - Automatic failover
 * - Circuit breaker pattern
 * - Service recovery detection
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('ServiceFailoverManager');

/**
 * Service states
 */
export const ServiceState = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  CIRCUIT_OPEN: 'circuit_open'
};

/**
 * Service Failover Manager
 */
export class ServiceFailoverManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Health check settings
      healthCheckInterval: config.healthCheckInterval || 30000, // 30 seconds
      healthCheckTimeout: config.healthCheckTimeout || 5000, // 5 seconds
      
      // Circuit breaker settings
      failureThreshold: config.failureThreshold || 5,
      successThreshold: config.successThreshold || 3,
      circuitOpenDuration: config.circuitOpenDuration || 60000, // 1 minute
      
      // Failover settings
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      fallbackOrder: config.fallbackOrder || [
        'btcpay_lightning',
        'simpleswap',
        'changenow',
        'coinpayments',
        'binance',
        'kraken'
      ]
    };
    
    // Service tracking
    this.services = new Map();
    this.circuitBreakers = new Map();
    this.healthCheckTimers = new Map();
    
    // Statistics
    this.stats = {
      failovers: 0,
      recoveries: 0,
      totalFailures: 0,
      currentPrimary: null
    };
  }
  
  /**
   * Register a service
   */
  registerService(serviceId, serviceConfig) {
    this.services.set(serviceId, {
      id: serviceId,
      config: serviceConfig,
      state: ServiceState.HEALTHY,
      lastCheck: null,
      failures: 0,
      successes: 0,
      responseTime: [],
      availability: 100
    });
    
    this.circuitBreakers.set(serviceId, {
      state: 'closed',
      failures: 0,
      lastFailure: null,
      nextAttempt: null
    });
    
    logger.info(`Registered service: ${serviceId}`);
  }
  
  /**
   * Start failover management
   */
  start() {
    logger.info('Starting failover manager...');
    
    // Start health checks for all services
    for (const serviceId of this.services.keys()) {
      this.startHealthCheck(serviceId);
    }
    
    this.emit('started');
  }
  
  /**
   * Stop failover management
   */
  stop() {
    logger.info('Stopping failover manager...');
    
    // Stop all health checks
    for (const timer of this.healthCheckTimers.values()) {
      clearInterval(timer);
    }
    this.healthCheckTimers.clear();
    
    this.emit('stopped');
  }
  
  /**
   * Start health check for a service
   */
  startHealthCheck(serviceId) {
    // Initial check
    this.performHealthCheck(serviceId);
    
    // Periodic checks
    const timer = setInterval(() => {
      this.performHealthCheck(serviceId);
    }, this.config.healthCheckInterval);
    
    this.healthCheckTimers.set(serviceId, timer);
  }
  
  /**
   * Perform health check
   */
  async performHealthCheck(serviceId) {
    const service = this.services.get(serviceId);
    if (!service) return;
    
    const circuitBreaker = this.circuitBreakers.get(serviceId);
    
    // Check if circuit is open
    if (circuitBreaker.state === 'open') {
      if (Date.now() < circuitBreaker.nextAttempt) {
        return; // Still in cooldown
      }
      // Try half-open state
      circuitBreaker.state = 'half-open';
    }
    
    try {
      const startTime = Date.now();
      
      // Perform actual health check (ping the service)
      const isHealthy = await this.checkServiceHealth(serviceId);
      
      const responseTime = Date.now() - startTime;
      
      // Update response time history
      service.responseTime.push(responseTime);
      if (service.responseTime.length > 100) {
        service.responseTime.shift();
      }
      
      if (isHealthy && responseTime < this.config.healthCheckTimeout) {
        this.handleHealthCheckSuccess(serviceId, responseTime);
      } else {
        throw new Error('Health check failed or timed out');
      }
      
    } catch (error) {
      this.handleHealthCheckFailure(serviceId, error);
    }
  }
  
  /**
   * Check service health (implementation depends on service type)
   */
  async checkServiceHealth(serviceId) {
    // This would be implemented based on the service type
    // For now, simulate with a simple check
    const service = this.services.get(serviceId);
    
    try {
      // Example: Try to get a rate quote
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.healthCheckTimeout);
      
      // Simulate API call
      const response = await fetch(`${service.config.apiUrl}/health`, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      return response.ok;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Handle successful health check
   */
  handleHealthCheckSuccess(serviceId, responseTime) {
    const service = this.services.get(serviceId);
    const circuitBreaker = this.circuitBreakers.get(serviceId);
    
    service.lastCheck = Date.now();
    service.failures = 0;
    service.successes++;
    
    // Update availability
    const avgResponseTime = service.responseTime.reduce((a, b) => a + b, 0) / service.responseTime.length;
    service.availability = Math.min(100, (service.successes / (service.successes + service.failures)) * 100);
    
    // Update state based on response time
    if (avgResponseTime < 1000) {
      service.state = ServiceState.HEALTHY;
    } else if (avgResponseTime < 3000) {
      service.state = ServiceState.DEGRADED;
    } else {
      service.state = ServiceState.UNHEALTHY;
    }
    
    // Reset circuit breaker if needed
    if (circuitBreaker.state === 'half-open') {
      circuitBreaker.failures = 0;
      circuitBreaker.state = 'closed';
      logger.info(`Service ${serviceId} recovered`);
      this.stats.recoveries++;
      this.emit('service:recovered', { serviceId });
    }
  }
  
  /**
   * Handle failed health check
   */
  handleHealthCheckFailure(serviceId, error) {
    const service = this.services.get(serviceId);
    const circuitBreaker = this.circuitBreakers.get(serviceId);
    
    service.lastCheck = Date.now();
    service.failures++;
    this.stats.totalFailures++;
    
    // Update circuit breaker
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();
    
    if (circuitBreaker.failures >= this.config.failureThreshold) {
      // Open circuit
      circuitBreaker.state = 'open';
      circuitBreaker.nextAttempt = Date.now() + this.config.circuitOpenDuration;
      service.state = ServiceState.CIRCUIT_OPEN;
      
      logger.warn(`Circuit breaker opened for ${serviceId}`);
      this.emit('circuit:opened', { serviceId });
      
      // Trigger failover if this was the primary service
      if (this.stats.currentPrimary === serviceId) {
        this.triggerFailover(serviceId);
      }
    } else {
      service.state = ServiceState.UNHEALTHY;
    }
    
    logger.error(`Health check failed for ${serviceId}:`, error.message);
  }
  
  /**
   * Trigger failover to next available service
   */
  async triggerFailover(failedServiceId) {
    logger.info(`Triggering failover from ${failedServiceId}`);
    this.stats.failovers++;
    
    // Find next healthy service in fallback order
    for (const serviceId of this.config.fallbackOrder) {
      if (serviceId === failedServiceId) continue;
      
      const service = this.services.get(serviceId);
      const circuitBreaker = this.circuitBreakers.get(serviceId);
      
      if (service && 
          service.state === ServiceState.HEALTHY && 
          circuitBreaker.state === 'closed') {
        
        this.stats.currentPrimary = serviceId;
        
        logger.info(`Failover to ${serviceId} successful`);
        this.emit('failover:completed', {
          from: failedServiceId,
          to: serviceId
        });
        
        return serviceId;
      }
    }
    
    logger.error('No healthy services available for failover!');
    this.emit('failover:failed', {
      from: failedServiceId,
      reason: 'No healthy services available'
    });
    
    return null;
  }
  
  /**
   * Get best available service
   */
  getBestAvailableService() {
    // Try to use current primary if healthy
    if (this.stats.currentPrimary) {
      const service = this.services.get(this.stats.currentPrimary);
      const circuitBreaker = this.circuitBreakers.get(this.stats.currentPrimary);
      
      if (service?.state === ServiceState.HEALTHY && 
          circuitBreaker?.state === 'closed') {
        return this.stats.currentPrimary;
      }
    }
    
    // Otherwise find best service based on fallback order
    for (const serviceId of this.config.fallbackOrder) {
      const service = this.services.get(serviceId);
      const circuitBreaker = this.circuitBreakers.get(serviceId);
      
      if (service && 
          (service.state === ServiceState.HEALTHY || service.state === ServiceState.DEGRADED) &&
          circuitBreaker.state === 'closed') {
        return serviceId;
      }
    }
    
    return null;
  }
  
  /**
   * Execute with failover
   */
  async executeWithFailover(operation, context = {}) {
    let lastError = null;
    let attempts = 0;
    
    while (attempts < this.config.maxRetries) {
      const serviceId = this.getBestAvailableService();
      
      if (!serviceId) {
        throw new Error('No available services');
      }
      
      try {
        // Execute operation
        const result = await operation(serviceId, context);
        
        // Success - update stats
        const service = this.services.get(serviceId);
        if (service) {
          service.successes++;
        }
        
        return {
          success: true,
          result,
          serviceUsed: serviceId,
          attempts: attempts + 1
        };
        
      } catch (error) {
        lastError = error;
        attempts++;
        
        logger.error(`Operation failed on ${serviceId}:`, error.message);
        
        // Mark service as failed
        this.handleHealthCheckFailure(serviceId, error);
        
        // Wait before retry
        if (attempts < this.config.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay * attempts));
        }
      }
    }
    
    throw new Error(`Operation failed after ${attempts} attempts: ${lastError?.message}`);
  }
  
  /**
   * Get service status
   */
  getServiceStatus() {
    const statuses = {};
    
    for (const [serviceId, service] of this.services) {
      const circuitBreaker = this.circuitBreakers.get(serviceId);
      
      statuses[serviceId] = {
        state: service.state,
        availability: service.availability.toFixed(2) + '%',
        avgResponseTime: service.responseTime.length > 0
          ? Math.round(service.responseTime.reduce((a, b) => a + b, 0) / service.responseTime.length)
          : 0,
        lastCheck: service.lastCheck,
        circuitBreaker: circuitBreaker.state,
        failures: service.failures,
        isPrimary: this.stats.currentPrimary === serviceId
      };
    }
    
    return statuses;
  }
  
  /**
   * Get failover statistics
   */
  getStats() {
    const healthyServices = Array.from(this.services.values())
      .filter(s => s.state === ServiceState.HEALTHY).length;
    
    return {
      ...this.stats,
      healthyServices,
      totalServices: this.services.size,
      serviceStatuses: this.getServiceStatus()
    };
  }
  
  /**
   * Force service recovery check
   */
  async checkServiceRecovery(serviceId) {
    const circuitBreaker = this.circuitBreakers.get(serviceId);
    
    if (circuitBreaker && circuitBreaker.state === 'open') {
      circuitBreaker.nextAttempt = Date.now(); // Force immediate check
      await this.performHealthCheck(serviceId);
    }
  }
}

export default ServiceFailoverManager;