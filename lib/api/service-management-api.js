/**
 * Service Management API
 * Admin dashboard API for managing external conversion services
 * 
 * Features:
 * - Service status monitoring
 * - Manual service control
 * - Rate monitoring
 * - Statistics and analytics
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('ServiceManagementAPI');

/**
 * Service Management API Endpoints
 */
export const SERVICE_MGMT_ENDPOINTS = {
  // Dashboard
  DASHBOARD: '/api/v1/admin/services/dashboard',
  
  // Service management
  SERVICE_LIST: '/api/v1/admin/services',
  SERVICE_STATUS: '/api/v1/admin/services/:id/status',
  SERVICE_ENABLE: '/api/v1/admin/services/:id/enable',
  SERVICE_DISABLE: '/api/v1/admin/services/:id/disable',
  SERVICE_TEST: '/api/v1/admin/services/:id/test',
  
  // Rate monitoring
  CURRENT_RATES: '/api/v1/admin/services/rates',
  RATE_HISTORY: '/api/v1/admin/services/rates/history',
  RATE_ALERTS: '/api/v1/admin/services/rates/alerts',
  
  // Failover management
  FAILOVER_STATUS: '/api/v1/admin/services/failover',
  FAILOVER_TRIGGER: '/api/v1/admin/services/failover/trigger',
  FAILOVER_HISTORY: '/api/v1/admin/services/failover/history',
  
  // Statistics
  CONVERSION_STATS: '/api/v1/admin/services/stats/conversions',
  FEE_SAVINGS: '/api/v1/admin/services/stats/savings',
  SERVICE_PERFORMANCE: '/api/v1/admin/services/stats/performance',
  
  // Configuration
  SERVICE_CONFIG: '/api/v1/admin/services/config',
  UPDATE_CONFIG: '/api/v1/admin/services/config/:id'
};

/**
 * Service Management API
 */
export class ServiceManagementAPI extends EventEmitter {
  constructor(apiServer, externalConverter, rateMonitor, failoverManager) {
    super();
    
    this.api = apiServer;
    this.converter = externalConverter;
    this.rateMonitor = rateMonitor;
    this.failoverManager = failoverManager;
    
    // Register endpoints
    this.registerEndpoints();
  }
  
  /**
   * Register API endpoints
   */
  registerEndpoints() {
    // Dashboard
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.DASHBOARD,
      this.requireAdmin(this.handleDashboard.bind(this)));
    
    // Service management
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.SERVICE_LIST,
      this.requireAdmin(this.handleServiceList.bind(this)));
    
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.SERVICE_STATUS,
      this.requireAdmin(this.handleServiceStatus.bind(this)));
    
    this.api.registerEndpoint('POST', SERVICE_MGMT_ENDPOINTS.SERVICE_ENABLE,
      this.requireAdmin(this.handleServiceEnable.bind(this)));
    
    this.api.registerEndpoint('POST', SERVICE_MGMT_ENDPOINTS.SERVICE_DISABLE,
      this.requireAdmin(this.handleServiceDisable.bind(this)));
    
    this.api.registerEndpoint('POST', SERVICE_MGMT_ENDPOINTS.SERVICE_TEST,
      this.requireAdmin(this.handleServiceTest.bind(this)));
    
    // Rate monitoring
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.CURRENT_RATES,
      this.requireAdmin(this.handleCurrentRates.bind(this)));
    
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.RATE_HISTORY,
      this.requireAdmin(this.handleRateHistory.bind(this)));
    
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.RATE_ALERTS,
      this.requireAdmin(this.handleRateAlerts.bind(this)));
    
    // Failover management
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.FAILOVER_STATUS,
      this.requireAdmin(this.handleFailoverStatus.bind(this)));
    
    this.api.registerEndpoint('POST', SERVICE_MGMT_ENDPOINTS.FAILOVER_TRIGGER,
      this.requireAdmin(this.handleFailoverTrigger.bind(this)));
    
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.FAILOVER_HISTORY,
      this.requireAdmin(this.handleFailoverHistory.bind(this)));
    
    // Statistics
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.CONVERSION_STATS,
      this.requireAdmin(this.handleConversionStats.bind(this)));
    
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.FEE_SAVINGS,
      this.requireAdmin(this.handleFeeSavings.bind(this)));
    
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.SERVICE_PERFORMANCE,
      this.requireAdmin(this.handleServicePerformance.bind(this)));
    
    // Configuration
    this.api.registerEndpoint('GET', SERVICE_MGMT_ENDPOINTS.SERVICE_CONFIG,
      this.requireAdmin(this.handleServiceConfig.bind(this)));
    
    this.api.registerEndpoint('PUT', SERVICE_MGMT_ENDPOINTS.UPDATE_CONFIG,
      this.requireAdmin(this.handleUpdateConfig.bind(this)));
  }
  
  /**
   * Require admin authentication
   */
  requireAdmin(handler) {
    return async (req, res) => {
      // Check admin API key
      const apiKey = req.headers['x-api-key'] || req.query.api_key;
      
      if (apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      return handler(req, res);
    };
  }
  
  /**
   * Handle dashboard request
   */
  async handleDashboard(req, res) {
    try {
      const dashboard = {
        overview: {
          totalServices: this.converter.services.size,
          healthyServices: 0,
          degradedServices: 0,
          failedServices: 0
        },
        currentRates: {},
        recentConversions: [],
        alerts: [],
        performance: {}
      };
      
      // Get service statuses
      if (this.failoverManager) {
        const statuses = this.failoverManager.getServiceStatus();
        for (const status of Object.values(statuses)) {
          if (status.state === 'healthy') dashboard.overview.healthyServices++;
          else if (status.state === 'degraded') dashboard.overview.degradedServices++;
          else dashboard.overview.failedServices++;
        }
      }
      
      // Get current rates
      if (this.rateMonitor) {
        dashboard.currentRates = this.rateMonitor.getCurrentRates();
      }
      
      // Get converter stats
      dashboard.performance = this.converter.getStats();
      
      res.json(dashboard);
      
    } catch (error) {
      logger.error('Dashboard error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle service list
   */
  async handleServiceList(req, res) {
    try {
      const services = [];
      
      for (const [serviceId, service] of this.converter.services) {
        const status = this.failoverManager?.getServiceStatus()[serviceId] || {};
        
        services.push({
          id: serviceId,
          name: service.name,
          fee: service.fee,
          enabled: service.initialized,
          status: status.state || 'unknown',
          availability: status.availability || '0%',
          responseTime: status.avgResponseTime || 0,
          features: {
            instantSwap: service.instantSwap,
            noKYC: service.noKYC,
            supportedCoins: Array.isArray(service.supportedCoins) 
              ? service.supportedCoins.length 
              : service.supportedCoins
          }
        });
      }
      
      res.json({ services });
      
    } catch (error) {
      logger.error('Service list error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle service status
   */
  async handleServiceStatus(req, res) {
    try {
      const serviceId = req.params.id;
      const service = this.converter.services.get(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: 'Service not found' });
      }
      
      const status = this.failoverManager?.getServiceStatus()[serviceId] || {};
      const rates = {};
      
      // Get current rates for this service
      for (const [key, rate] of Object.entries(this.rateMonitor?.getCurrentRates() || {})) {
        if (key.startsWith(serviceId)) {
          rates[key] = rate;
        }
      }
      
      res.json({
        service: {
          id: serviceId,
          name: service.name,
          ...service
        },
        status,
        rates,
        lastUpdate: Date.now()
      });
      
    } catch (error) {
      logger.error('Service status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle service test
   */
  async handleServiceTest(req, res) {
    try {
      const serviceId = req.params.id;
      const { fromCoin = 'ETH', toCoin = 'BTC', amount = 1 } = req.body;
      
      const startTime = Date.now();
      
      try {
        const rate = await this.converter.getServiceRate(serviceId, fromCoin, toCoin, amount);
        const responseTime = Date.now() - startTime;
        
        res.json({
          success: true,
          serviceId,
          test: {
            fromCoin,
            toCoin,
            amount,
            rate: rate?.rate,
            fee: rate?.fee,
            effectiveRate: rate?.effectiveRate,
            responseTime
          }
        });
        
      } catch (error) {
        res.json({
          success: false,
          serviceId,
          error: error.message,
          responseTime: Date.now() - startTime
        });
      }
      
    } catch (error) {
      logger.error('Service test error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle current rates
   */
  async handleCurrentRates(req, res) {
    try {
      const rates = this.rateMonitor?.getCurrentRates() || {};
      const formatted = {};
      
      // Format rates by pair
      for (const [key, rate] of Object.entries(rates)) {
        const [service, from, to] = key.split(':');
        const pair = `${from}:${to}`;
        
        if (!formatted[pair]) {
          formatted[pair] = {};
        }
        
        formatted[pair][service] = rate;
      }
      
      res.json({
        rates: formatted,
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Current rates error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle fee savings
   */
  async handleFeeSavings(req, res) {
    try {
      const stats = this.converter.getStats();
      const traditionalFee = 0.025; // 2.5% average
      
      const savings = {
        totalVolume: stats.totalVolume || 0,
        totalSaved: stats.totalFeesSaved || 0,
        averageSavings: stats.totalVolume > 0 
          ? (stats.totalFeesSaved / stats.totalVolume * 100) 
          : 0,
        comparison: {
          otedama: {
            pool: '1.2%',
            solo: '0.7%'
          },
          traditional: {
            exchange: '2-3%',
            nicehash: '2%',
            prohashing: '1.5%'
          }
        },
        projectedAnnualSavings: stats.totalVolume > 0
          ? (stats.totalFeesSaved / stats.totalVolume) * stats.totalVolume * 365
          : 0
      };
      
      res.json(savings);
      
    } catch (error) {
      logger.error('Fee savings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle service enable
   */
  async handleServiceEnable(req, res) {
    try {
      const serviceId = req.params.id;
      const service = this.converter.services.get(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: 'Service not found' });
      }
      
      service.initialized = true;
      
      // Force recovery check if circuit is open
      if (this.failoverManager) {
        await this.failoverManager.checkServiceRecovery(serviceId);
      }
      
      res.json({
        success: true,
        serviceId,
        message: 'Service enabled'
      });
      
    } catch (error) {
      logger.error('Service enable error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle service disable
   */
  async handleServiceDisable(req, res) {
    try {
      const serviceId = req.params.id;
      const service = this.converter.services.get(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: 'Service not found' });
      }
      
      service.initialized = false;
      
      res.json({
        success: true,
        serviceId,
        message: 'Service disabled'
      });
      
    } catch (error) {
      logger.error('Service disable error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  // Placeholder methods for remaining endpoints
  async handleRateHistory(req, res) {
    res.json({ history: [], message: 'Coming soon' });
  }
  
  async handleRateAlerts(req, res) {
    const stats = this.rateMonitor?.getStats() || {};
    res.json({ 
      alerts: stats.recentAlerts || [],
      totalAlerts: stats.alertsSent || 0
    });
  }
  
  async handleFailoverStatus(req, res) {
    const stats = this.failoverManager?.getStats() || {};
    res.json(stats);
  }
  
  async handleFailoverTrigger(req, res) {
    const { fromService } = req.body;
    
    if (!fromService) {
      return res.status(400).json({ error: 'fromService required' });
    }
    
    const newService = await this.failoverManager?.triggerFailover(fromService);
    
    res.json({
      success: !!newService,
      fromService,
      toService: newService,
      message: newService ? 'Failover successful' : 'No available services'
    });
  }
  
  async handleFailoverHistory(req, res) {
    res.json({ history: [], message: 'Coming soon' });
  }
  
  async handleConversionStats(req, res) {
    const stats = this.converter.getStats();
    res.json(stats);
  }
  
  async handleServicePerformance(req, res) {
    const performance = this.failoverManager?.getServiceStatus() || {};
    res.json({ services: performance });
  }
  
  async handleServiceConfig(req, res) {
    const config = {};
    
    for (const [serviceId, service] of this.converter.services) {
      config[serviceId] = {
        ...service,
        apiKey: service.apiKey ? '***' : 'Not configured'
      };
    }
    
    res.json({ config });
  }
  
  async handleUpdateConfig(req, res) {
    res.json({ 
      success: false, 
      message: 'Configuration updates require server restart' 
    });
  }
}

export default ServiceManagementAPI;