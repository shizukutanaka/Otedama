/**
 * Monitoring System for Otedama
 * 
 * Provides unified monitoring capabilities following KISS principle
 * 
 * Design principles:
 * - Carmack: High-performance, minimal overhead
 * - Martin: Clean interfaces, single responsibility
 * - Pike: Simple and powerful
 */

const EnterpriseMonitor = require('./enterprise-monitor');

// Singleton instance
let monitoringInstance = null;

/**
 * Get or create monitoring instance
 */
function getMonitor(config) {
  if (!monitoringInstance) {
    monitoringInstance = new EnterpriseMonitor(config);
  }
  return monitoringInstance;
}

/**
 * Create monitoring middleware for Express/Koa
 */
function createMiddleware(monitor) {
  return (req, res, next) => {
    const start = Date.now();
    
    // Override end to capture metrics
    const originalEnd = res.end;
    res.end = function(...args) {
      const duration = Date.now() - start;
      const route = req.route?.path || req.path || req.url;
      
      // Record application metrics
      monitor.collectApplicationMetrics(Date.now());
      
      // Emit request event
      monitor.emit('request', {
        method: req.method,
        route,
        statusCode: res.statusCode,
        duration
      });
      
      return originalEnd.apply(res, args);
    };
    
    next();
  };
}

/**
 * Create metrics endpoint handler
 */
function createMetricsEndpoint(monitor) {
  return async (req, res) => {
    try {
      const metrics = monitor.getCurrentMetrics();
      res.json(metrics);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
}

module.exports = {
  // Main monitor class
  EnterpriseMonitor,
  
  // Factory function
  getMonitor,
  
  // Middleware creators
  createMiddleware,
  createMetricsEndpoint,
  
  // Convenience exports
  monitor: getMonitor(),
  
  // Start monitoring
  start: (config) => {
    const monitor = getMonitor(config);
    return monitor.start();
  },
  
  // Stop monitoring
  stop: () => {
    if (monitoringInstance) {
      return monitoringInstance.stop();
    }
  }
};