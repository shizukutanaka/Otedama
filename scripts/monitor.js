#!/usr/bin/env node
/**
 * Otedama Pool Monitor Starter
 * Simple wrapper to start the monitoring dashboard
 * 
 * Design principles:
 * - Carmack: Fast startup with minimal overhead
 * - Martin: Clean separation of concerns
 * - Pike: Simple and effective monitoring
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { UnifiedMonitoringSystem } from '../lib/monitoring/unified-monitoring-system.js';
import { UnifiedDashboard } from '../lib/monitoring/unified-dashboard.js';
import { RealtimeMetrics } from '../lib/monitoring/realtime-metrics.js';
import { PrometheusExporter } from '../lib/monitoring/prometheus-exporter.js';

const logger = createStructuredLogger('MonitorStarter');

/**
 * Start monitoring dashboard and services
 */
export default async function startMonitor(config = {}) {
  logger.info('Starting Otedama monitoring dashboard');
  
  try {
    const monitorConfig = {
      port: config.monitoring?.port || 8082,
      metricsPort: config.monitoring?.metricsPort || 9090,
      updateInterval: config.monitoring?.updateInterval || 5000,
      enablePrometheus: config.monitoring?.prometheus !== false,
      enableRealtime: config.monitoring?.realtime !== false,
      apiUrl: config.pool?.apiUrl || 'http://localhost:8081',
      ...config.monitoring
    };
    
    // Initialize monitoring components
    const components = await initializeMonitoringComponents(monitorConfig);
    
    // Start monitoring services
    await startMonitoringServices(components, monitorConfig);
    
    // Display monitoring information
    displayMonitoringInfo(monitorConfig);
    
    // Setup shutdown handlers
    setupMonitoringShutdown(components);
    
    return components;
    
  } catch (error) {
    logger.error('Failed to start monitoring', { error: error.message });
    throw error;
  }
}

/**
 * Initialize monitoring components
 */
async function initializeMonitoringComponents(config) {
  logger.info('Initializing monitoring components');
  
  const components = {};
  
  try {
    // Real-time metrics system
    if (config.enableRealtime) {
      components.realtimeMetrics = new RealtimeMetrics({
        updateInterval: config.updateInterval,
        apiUrl: config.apiUrl
      });
      await components.realtimeMetrics.initialize();
      logger.info('Real-time metrics initialized');
    }
    
    // Prometheus exporter
    if (config.enablePrometheus) {
      components.prometheusExporter = new PrometheusExporter({
        port: config.metricsPort,
        apiUrl: config.apiUrl
      });
      await components.prometheusExporter.initialize();
      logger.info('Prometheus exporter initialized');
    }
    
    // Unified monitoring system
    components.monitoringSystem = new UnifiedMonitoringSystem({
      ...config,
      realtimeMetrics: components.realtimeMetrics,
      prometheusExporter: components.prometheusExporter
    });
    await components.monitoringSystem.initialize();
    logger.info('Unified monitoring system initialized');
    
    // Dashboard
    components.dashboard = new UnifiedDashboard({
      port: config.port,
      monitoringSystem: components.monitoringSystem,
      realtimeMetrics: components.realtimeMetrics,
      apiUrl: config.apiUrl
    });
    await components.dashboard.initialize();
    logger.info('Dashboard initialized');
    
    return components;
    
  } catch (error) {
    logger.error('Monitoring component initialization failed', { error: error.message });
    await cleanupMonitoringComponents(components);
    throw error;
  }
}

/**
 * Start monitoring services
 */
async function startMonitoringServices(components, config) {
  logger.info('Starting monitoring services');
  
  try {
    // Start services in order
    if (components.realtimeMetrics) {
      await components.realtimeMetrics.start();
    }
    
    if (components.prometheusExporter) {
      await components.prometheusExporter.start();
    }
    
    await components.monitoringSystem.start();
    await components.dashboard.start();
    
    logger.info('All monitoring services started successfully');
    
  } catch (error) {
    logger.error('Failed to start monitoring services', { error: error.message });
    await stopMonitoringServices(components);
    throw error;
  }
}

/**
 * Display monitoring information
 */
function displayMonitoringInfo(config) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 OTEDAMA MONITORING DASHBOARD STARTED');
  console.log('='.repeat(60));
  console.log(`Dashboard: http://localhost:${config.port}`);
  if (config.enablePrometheus) {
    console.log(`Metrics: http://localhost:${config.metricsPort}/metrics`);
  }
  console.log(`API Source: ${config.apiUrl}`);
  console.log(`Update Interval: ${config.updateInterval}ms`);
  console.log(`Real-time: ${config.enableRealtime ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Prometheus: ${config.enablePrometheus ? 'ENABLED' : 'DISABLED'}`);
  console.log('='.repeat(60));
  console.log('📈 Real-time pool statistics and monitoring available');
  console.log('🎯 Connect to dashboard URL to view detailed metrics');
  console.log('='.repeat(60) + '\n');
}

/**
 * Setup shutdown handlers for monitoring
 */
function setupMonitoringShutdown(components) {
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down monitoring...`);
    
    try {
      await stopMonitoringServices(components);
      await cleanupMonitoringComponents(components);
      
      logger.info('Monitoring shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during monitoring shutdown', { error: error.message });
      process.exit(1);
    }
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Stop monitoring services in reverse order
 */
async function stopMonitoringServices(components) {
  const stopOrder = ['dashboard', 'monitoringSystem', 'prometheusExporter', 'realtimeMetrics'];
  
  for (const componentName of stopOrder) {
    if (components[componentName]?.stop) {
      try {
        await components[componentName].stop();
        logger.info(`${componentName} stopped`);
      } catch (error) {
        logger.error(`Error stopping ${componentName}`, { error: error.message });
      }
    }
  }
}

/**
 * Clean up monitoring components
 */
async function cleanupMonitoringComponents(components) {
  for (const [name, component] of Object.entries(components)) {
    if (component?.cleanup) {
      try {
        await component.cleanup();
      } catch (error) {
        logger.error(`Error cleaning up ${name}`, { error: error.message });
      }
    }
  }
}

/**
 * Main function for standalone execution
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const defaultConfig = {
    monitoring: {
      port: 8082,
      metricsPort: 9090,
      updateInterval: 5000,
      enablePrometheus: true,
      enableRealtime: true,
      apiUrl: 'http://localhost:8081'
    }
  };
  
  startMonitor(defaultConfig).catch(error => {
    console.error('Failed to start monitoring:', error);
    process.exit(1);
  });
}